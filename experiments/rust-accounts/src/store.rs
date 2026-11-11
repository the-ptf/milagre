//! Fresh-copy capability and descriptor-relative atomic metadata storage (Unix only).
use crate::{
    journal::{self, Entry, Identity, Journal, Step},
    AccountError, Accounts, Result,
};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;
const MARKER: &str = "MILAGRE-ACCOUNT-COPY";
const META: &str = "accounts.json";
const LOCK: &str = ".metadata-writer.lock";
const UNSAFE: &str = "Account copy ownership or file containment changed.";
const IO: &str = "Could not persist isolated account metadata.";
const BUSY: &str = "This isolated account copy already has a writer.";
#[derive(Clone)]
pub struct AccountSandbox(Arc<Root>);
struct Root {
    path: PathBuf,
    dir: File,
    accounts: File,
    staging: File,
    marker: String,
    links: Mutex<BTreeMap<PathBuf, ManagedLink>>,
    journal_key: [u8; 32],
    journal: Mutex<JournalState>,
}
impl std::fmt::Debug for AccountSandbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccountSandbox(<private copy>)")
    }
}
impl AccountSandbox {
    /// Create a new private copy under the OS's fixed temp root, never HOME/TMPDIR.
    /// `seed` is supplied metadata, not a path. Existing paths cannot be adopted.
    pub fn create(seed: Option<&str>) -> Result<Self> {
        if seed.is_some_and(|body| body.len() > 4 * 1024 * 1024) {
            return Err(AccountError(crate::READ_ERROR));
        }
        Accounts::parse(seed)?;
        let base = fs::canonicalize("/tmp").map_err(|_| AccountError(IO))?;
        if base != Path::new("/tmp") && base != Path::new("/private/tmp") {
            return Err(AccountError(UNSAFE));
        }
        let temp = tempfile::Builder::new()
            .prefix("milagre-account-copy-")
            .tempdir_in(&base)
            .map_err(|_| AccountError(IO))?;
        let path = temp.path().to_owned();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| AccountError(IO))?;
        let dir = open_path(&path)?;
        let marker = Uuid::new_v4().to_string();
        write_new(&dir, MARKER, marker.as_bytes())?;
        mkdir(&dir, "accounts")?;
        let accounts = open(&dir, "accounts", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        if let Some(seed) = seed {
            write_new(&accounts, META, seed.as_bytes())?;
        }
        write_new(&accounts, LOCK, b"")?;
        mkdir(&dir, ".preparation-staging")?;
        let staging = open(
            &dir,
            ".preparation-staging",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        // No recursive destructor: a later path replacement must never cause deletion of someone
        // else's files. Tests remove their known copies explicitly after dropping every handle.
        let _ = temp.keep();
        let mut journal_key = [0; 32];
        journal_key[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        journal_key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        let initial = Journal {
            version: 1,
            ..Default::default()
        };
        let bytes = journal::encode(&initial, &journal_key)?;
        write_new(&dir, journal::FILE, &bytes)?;
        dir.sync_all().map_err(|_| AccountError(IO))?;
        let result = Self(Arc::new(Root {
            path,
            dir,
            accounts,
            staging,
            marker,
            links: Mutex::new(BTreeMap::new()),
            journal_key,
            journal: Mutex::new(JournalState {
                data: initial,
                bytes,
            }),
        }));
        result.verify()?;
        Ok(result)
    }
    /// Diagnostic/test path only. Mutations never accept caller paths and use pinned descriptors.
    pub fn path(&self) -> &Path {
        &self.0.path
    }
    pub(crate) fn acquire(&self) -> Result<Writer> {
        self.verify_base()?;
        let root_lock = open_path(&self.0.path)?;
        // Lock the pinned directory inode too: replacing the lock file cannot admit a second writer.
        if unsafe { libc::flock(root_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(AccountError(BUSY));
        }
        let lock = open(&self.0.accounts, LOCK, libc::O_RDWR, 0)?;
        safe_file(&lock)?;
        // SAFETY: flock acts on this owned open descriptor, with no pointer arguments.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(AccountError(BUSY));
        }
        self.reload_journal()?;
        let writer = Writer {
            sandbox: self.clone(),
            lock,
            _root_lock: root_lock,
            expected: read_optional(&self.0.accounts, META)?,
        };
        writer.verify()?;
        Ok(writer)
    }
    fn verify_base(&self) -> Result<()> {
        let root = &self.0;
        let at = fs::symlink_metadata(&root.path).map_err(|_| AccountError(UNSAFE))?;
        let held = root.dir.metadata().map_err(|_| AccountError(UNSAFE))?;
        if !at.is_dir() || at.file_type().is_symlink() || !same(&at, &held) {
            return Err(AccountError(UNSAFE));
        }
        safe_dir(&root.dir)?;
        let current = open(&root.dir, "accounts", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        if !same(
            &current.metadata().map_err(|_| AccountError(UNSAFE))?,
            &root.accounts.metadata().map_err(|_| AccountError(UNSAFE))?,
        ) {
            return Err(AccountError(UNSAFE));
        }
        let staging = open(
            &root.dir,
            ".preparation-staging",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        if !same(
            &staging.metadata().map_err(|_| AccountError(UNSAFE))?,
            &root.staging.metadata().map_err(|_| AccountError(UNSAFE))?,
        ) {
            return Err(AccountError(UNSAFE));
        }
        let marker = read_optional(&root.dir, MARKER)?.ok_or(AccountError(UNSAFE))?;
        if marker != root.marker.as_bytes() {
            return Err(AccountError(UNSAFE));
        }
        Ok(())
    }
    fn verify(&self) -> Result<()> {
        self.verify_base()?;
        let root = &self.0;
        let journal = root.journal.lock().map_err(|_| AccountError(UNSAFE))?;
        if read_optional_limit(&root.dir, journal::FILE, journal::LIMIT)?.as_deref()
            != Some(journal.bytes.as_slice())
        {
            return Err(AccountError(
                "Isolated preparation journal changed outside its writer.",
            ));
        }
        validate_dirs(root, &journal.data)?;
        let mut count = 0;
        let links = root.links.lock().map_err(|_| AccountError(UNSAFE))?;
        scan(&root.path, 0, &mut count, &links)?;
        for (path, link) in links.iter() {
            link.verify(path)?;
        }
        Ok(())
    }
}
pub(crate) struct Writer {
    sandbox: AccountSandbox,
    lock: File,
    _root_lock: File,
    expected: Option<Vec<u8>>,
}
impl Writer {
    pub(crate) fn body(&self) -> Result<Option<&str>> {
        self.expected
            .as_deref()
            .map(std::str::from_utf8)
            .transpose()
            .map_err(|_| AccountError(crate::READ_ERROR))
    }
    pub(crate) fn verify(&self) -> Result<()> {
        self.sandbox.verify()?;
        let current = open(&self.sandbox.0.accounts, LOCK, libc::O_RDWR, 0)?;
        if !same(
            &current.metadata().map_err(|_| AccountError(UNSAFE))?,
            &self.lock.metadata().map_err(|_| AccountError(UNSAFE))?,
        ) {
            return Err(AccountError(UNSAFE));
        }
        if read_optional(&self.sandbox.0.accounts, META)? != self.expected {
            return Err(AccountError(
                "Isolated account metadata changed outside its writer.",
            ));
        }
        Ok(())
    }
    pub(crate) fn persist(&mut self, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(AccountError(crate::READ_ERROR));
        }
        self.persist_checked(bytes, || Ok(()))
    }
    fn persist_checked(
        &mut self,
        bytes: Vec<u8>,
        before_rename: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        let name = format!(".accounts-{}.tmp", Uuid::new_v4());
        let dir = &self.sandbox.0.accounts;
        let temp_dir = &self.sandbox.0.staging;
        journal::checkpoint("metadata-before-temp")?;
        let mut file = open(
            temp_dir,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            file.write_all(&bytes).map_err(|_| AccountError(IO))?;
            file.sync_all().map_err(|_| AccountError(IO))?;
            temp_dir.sync_all().map_err(|_| AccountError(IO))?;
            journal::checkpoint("metadata-temp-synced")?;
            before_rename()?;
            self.verify()?;
            let from = CString::new(name.as_str()).map_err(|_| AccountError(IO))?;
            let to = CString::new(META).map_err(|_| AccountError(IO))?;
            // SAFETY: both names are validated NUL-free constants/generated names in the same held dir.
            if unsafe {
                libc::renameat(
                    temp_dir.as_raw_fd(),
                    from.as_ptr(),
                    dir.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(AccountError(IO));
            }
            journal::checkpoint("metadata-renamed")?;
            dir.sync_all().map_err(|_| AccountError(IO))?;
            temp_dir.sync_all().map_err(|_| AccountError(IO))?;
            journal::checkpoint("metadata-directory-synced")?;
            Ok(())
        })();
        if result.is_err() {
            unlink_same(temp_dir, &name, &file);
        }
        result?;
        self.expected = Some(bytes);
        Ok(())
    }
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn safe_file(file: &File) -> Result<()> {
    let m = file.metadata().map_err(|_| AccountError(UNSAFE))?;
    // SAFETY: geteuid has no preconditions.
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o777 != 0o600
    {
        return Err(AccountError(UNSAFE));
    }
    Ok(())
}
fn safe_dir(file: &File) -> Result<()> {
    let m = file.metadata().map_err(|_| AccountError(UNSAFE))?;
    // SAFETY: geteuid has no preconditions.
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o700 {
        return Err(AccountError(UNSAFE));
    }
    Ok(())
}
fn open_path(path: &Path) -> Result<File> {
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| AccountError(UNSAFE))?;
    // SAFETY: c is a live NUL-terminated path; returned descriptor is transferred exactly once.
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(AccountError(UNSAFE));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    safe_dir(&file)?;
    Ok(file)
}
fn open(dir: &File, name: &str, flags: i32, mode: libc::mode_t) -> Result<File> {
    if name.contains('/') || matches!(name, "." | "..") {
        return Err(AccountError(UNSAFE));
    }
    let name = CString::new(name).map_err(|_| AccountError(UNSAFE))?;
    // SAFETY: descriptor is owned/live and name is NUL terminated. mode is passed for O_CREAT.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(AccountError(IO));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    if flags & libc::O_DIRECTORY != 0 {
        safe_dir(&file)?;
    } else {
        safe_file(&file)?;
    }
    Ok(file)
}
fn read_optional(dir: &File, name: &str) -> Result<Option<Vec<u8>>> {
    read_optional_limit(dir, name, 4 * 1024 * 1024)
}
fn read_optional_limit(dir: &File, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    let name = CString::new(name).map_err(|_| AccountError(UNSAFE))?;
    // SAFETY: held dir and NUL-terminated fixed basename. No symlink is followed.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(AccountError(UNSAFE))
        };
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    safe_file(&file)?;
    let before = file.metadata().map_err(|_| AccountError(UNSAFE))?;
    if before.len() > limit as u64 {
        return Err(AccountError(crate::READ_ERROR));
    }
    let mut body = Vec::new();
    Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| AccountError(crate::READ_ERROR))?;
    if body.len() > limit {
        return Err(AccountError(crate::READ_ERROR));
    }
    let after = file.metadata().map_err(|_| AccountError(UNSAFE))?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(AccountError(UNSAFE));
    }
    Ok(Some(body))
}
fn write_new(dir: &File, name: &str, body: &[u8]) -> Result<()> {
    let mut f = open(
        dir,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    f.write_all(body).map_err(|_| AccountError(IO))
}
fn mkdir(dir: &File, name: &str) -> Result<()> {
    let name = CString::new(name).map_err(|_| AccountError(IO))?;
    // SAFETY: held directory and NUL-terminated name.
    if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(AccountError(IO));
    }
    Ok(())
}
fn unlink_same(dir: &File, name: &str, file: &File) {
    let Ok(current) = open(dir, name, libc::O_RDONLY, 0) else {
        return;
    };
    let (Ok(a), Ok(b)) = (current.metadata(), file.metadata()) else {
        return;
    };
    if !same(&a, &b) {
        return;
    }
    if let Ok(name) = CString::new(name) {
        // SAFETY: only the matching generated temp inode is unlinked in its held directory.
        unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
    }
}
fn scan(
    path: &Path,
    depth: usize,
    count: &mut usize,
    links: &BTreeMap<PathBuf, ManagedLink>,
) -> Result<()> {
    *count += 1;
    if depth > 32 || *count > 8192 {
        return Err(AccountError(UNSAFE));
    }
    let m = fs::symlink_metadata(path).map_err(|_| AccountError(UNSAFE))?;
    // Only links minted by this exact capability may exist; never follow them in the scan.
    if m.file_type().is_symlink() {
        return links.get(path).ok_or(AccountError(UNSAFE))?.verify(path);
    }
    if !m.is_dir() && (!m.is_file() || m.nlink() != 1) {
        return Err(AccountError(UNSAFE));
    }
    if m.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| AccountError(UNSAFE))? {
            scan(
                &entry.map_err(|_| AccountError(UNSAFE))?.path(),
                depth + 1,
                count,
                links,
            )?;
        }
    }
    Ok(())
}

// Registry lives with the unforgeable copy capability, not with a service/lock. Reopening the
// same copy can verify its own links, but no process can adopt arbitrary pre-existing links.
struct ManagedLink {
    target: PathBuf,
    link: (u64, u64),
    source: (u64, u64),
}
impl ManagedLink {
    fn verify(&self, path: &Path) -> Result<()> {
        let at = fs::symlink_metadata(path).map_err(|_| AccountError(UNSAFE))?;
        let source = fs::symlink_metadata(&self.target).map_err(|_| AccountError(UNSAFE))?;
        if !at.file_type().is_symlink()
            || (at.dev(), at.ino()) != self.link
            || fs::read_link(path).map_err(|_| AccountError(UNSAFE))? != self.target
            || !source.is_dir()
            || source.file_type().is_symlink()
            || (source.dev(), source.ino()) != self.source
        {
            return Err(AccountError(UNSAFE));
        }
        Ok(())
    }
}
impl Writer {
    pub(crate) fn root_path(&self) -> &Path {
        self.sandbox.path()
    }
    pub(crate) fn prepared(&self, key: &str) -> Result<bool> {
        self.verify()?;
        Ok(self
            .sandbox
            .0
            .journal
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .data
            .entries
            .get(key)
            .is_some_and(|e| e.complete))
    }
    // All callers supply fixed components or an already validated account UUID. No caller paths.
    fn directory(&self, parts: &[&str], create: bool) -> Result<File> {
        walk(&self.sandbox.0.dir, parts, create)
    }
    pub(crate) fn profile_directory(&self, parts: &[&str]) -> Result<()> {
        self.verify()?;
        self.directory(parts, true)?;
        self.verify()
    }
    pub(crate) fn profile_absent(&self, parts: &[&str]) -> Result<bool> {
        self.verify()?;
        let path = parts
            .iter()
            .fold(self.root_path().to_owned(), |p, c| p.join(c));
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(_) => Err(AccountError(UNSAFE)),
        }
    }
    pub(crate) fn profile_read(&self, parts: &[&str], name: &str) -> Result<Option<String>> {
        self.verify()?;
        let dir = self.directory(parts, false)?;
        read_optional(&dir, name)?
            .map(|b| String::from_utf8(b).map_err(|_| AccountError(crate::READ_ERROR)))
            .transpose()
    }
    pub(crate) fn profile_write(&self, parts: &[&str], name: &str, text: &str) -> Result<()> {
        if text.len() > 4 * 1024 * 1024 {
            return Err(AccountError(crate::READ_ERROR));
        }
        self.verify()?;
        let dir = self.directory(parts, true)?;
        let before = read_optional(&dir, name)?;
        if before.as_deref() == Some(text.as_bytes()) {
            return Ok(());
        }
        journal::checkpoint("profile-before-temp")?;
        let temp_dir = &self.sandbox.0.staging;
        let temp = format!(".profile-{}.tmp", Uuid::new_v4());
        let mut file = open(
            temp_dir,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            file.write_all(text.as_bytes())
                .map_err(|_| AccountError(IO))?;
            file.sync_all().map_err(|_| AccountError(IO))?;
            temp_dir.sync_all().map_err(|_| AccountError(IO))?;
            journal::checkpoint("profile-temp-synced")?;
            self.verify()?;
            let current = self.directory(parts, false)?;
            if !same(
                &current.metadata().map_err(|_| AccountError(UNSAFE))?,
                &dir.metadata().map_err(|_| AccountError(UNSAFE))?,
            ) || read_optional(&dir, name)? != before
            {
                return Err(AccountError(UNSAFE));
            }
            let from = CString::new(temp.as_str()).map_err(|_| AccountError(IO))?;
            let to = CString::new(name).map_err(|_| AccountError(IO))?;
            if unsafe {
                libc::renameat(
                    temp_dir.as_raw_fd(),
                    from.as_ptr(),
                    dir.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(AccountError(IO));
            }
            journal::checkpoint("profile-renamed")?;
            dir.sync_all().map_err(|_| AccountError(IO))?;
            temp_dir.sync_all().map_err(|_| AccountError(IO))?;
            Ok(())
        })();
        if result.is_err() {
            unlink_same(temp_dir, &temp, &file);
        }
        result
    }
    pub(crate) fn profile_link(&self, at: &[&str], source: &[&str]) -> Result<()> {
        self.verify()?;
        let (name, parent) = at.split_last().ok_or(AccountError(UNSAFE))?;
        let dir = self.directory(parent, true)?;
        let source_dir = self.directory(source, false)?;
        let target = source
            .iter()
            .fold(self.root_path().to_owned(), |p, c| p.join(c));
        let path = at
            .iter()
            .fold(self.root_path().to_owned(), |p, c| p.join(c));
        if let Some(link) = self
            .sandbox
            .0
            .links
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .get(&path)
        {
            if link.target != target {
                return Err(AccountError(UNSAFE));
            }
            return link.verify(&path);
        }
        let target_c = CString::new(target.to_str().ok_or(AccountError(UNSAFE))?)
            .map_err(|_| AccountError(UNSAFE))?;
        let name_c = CString::new(*name).map_err(|_| AccountError(UNSAFE))?;
        if unsafe { libc::symlinkat(target_c.as_ptr(), dir.as_raw_fd(), name_c.as_ptr()) } != 0 {
            return Err(AccountError(IO));
        }
        let at_meta = fs::symlink_metadata(&path).map_err(|_| AccountError(UNSAFE))?;
        let source_meta = source_dir.metadata().map_err(|_| AccountError(UNSAFE))?;
        let link = ManagedLink {
            target,
            link: (at_meta.dev(), at_meta.ino()),
            source: (source_meta.dev(), source_meta.ino()),
        };
        link.verify(&path)?;
        self.sandbox
            .0
            .links
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .insert(path, link);
        self.verify()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_after_temp_sync_preserves_old_metadata_and_cleans_only_its_temp() {
        let sandbox = AccountSandbox::create(Some(r#"{"accounts":[],"selected":{}}"#)).unwrap();
        let path = sandbox.path().to_owned();
        let mut writer = sandbox.acquire().unwrap();
        let before = writer.expected.clone();
        assert!(writer
            .persist_checked(
                br#"{"accounts":[],"selected":{"codex":"default"}}"#.to_vec(),
                || Err(AccountError("injected before rename"))
            )
            .is_err());
        assert_eq!(writer.expected, before);
        assert_eq!(read_optional(&sandbox.0.accounts, META).unwrap(), before);
        assert!(fs::read_dir(path.join("accounts")).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        writer
            .persist(br#"{"accounts":[],"selected":{"codex":"default"}}"#.to_vec())
            .unwrap();
        drop(writer);
        drop(sandbox);
        fs::remove_dir_all(path).unwrap();
    }
}

struct JournalState {
    data: Journal,
    bytes: Vec<u8>,
}
fn walk(root: &File, parts: &[&str], create: bool) -> Result<File> {
    let mut dir = root.try_clone().map_err(|_| AccountError(IO))?;
    for part in parts {
        if part.is_empty() || part.contains('/') || matches!(*part, "." | "..") {
            return Err(AccountError(UNSAFE));
        }
        if create {
            let c = CString::new(*part).map_err(|_| AccountError(UNSAFE))?;
            if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o700) } != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(AccountError(IO));
            }
        }
        dir = open(&dir, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    }
    Ok(dir)
}
fn validate_dirs(root: &Root, journal: &Journal) -> Result<()> {
    for (path, id) in &journal.dirs {
        let parts = journal::split(path);
        let dir = walk(&root.dir, &journal::refs(&parts), false)?;
        if Identity::of(&dir.metadata().map_err(|_| AccountError(UNSAFE))?) != *id {
            return Err(AccountError(UNSAFE));
        }
    }
    Ok(())
}
impl AccountSandbox {
    fn reload_journal(&self) -> Result<()> {
        self.verify_base()?;
        let root = &self.0;
        let bytes = read_optional_limit(&root.dir, journal::FILE, journal::LIMIT)?
            .ok_or(AccountError(UNSAFE))?;
        let data = journal::decode(&bytes, &root.journal_key)?;
        if data.revision
            < root
                .journal
                .lock()
                .map_err(|_| AccountError(UNSAFE))?
                .data
                .revision
        {
            return Err(AccountError(
                "Isolated preparation journal was rolled back.",
            ));
        }
        validate_dirs(root, &data)?;
        let mut links = BTreeMap::new();
        for (path, record) in &data.links {
            let parts = journal::split(path);
            let (parent_name, parent_parts) = parts.split_last().ok_or(AccountError(UNSAFE))?;
            let _parent = walk(&root.dir, &journal::refs(parent_parts), false)?;
            let source = walk(&root.dir, &journal::refs(&record.target), false)?;
            if Identity::of(&source.metadata().map_err(|_| AccountError(UNSAFE))?) != record.source
            {
                return Err(AccountError(UNSAFE));
            }
            let path = root.path.join(path);
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && record.inode.is_none() => {
                    continue
                }
                Err(_) => return Err(AccountError(UNSAFE)),
            };
            let id = Identity::of(&meta);
            if record.inode.is_some_and(|expected| expected != id) {
                return Err(AccountError(UNSAFE));
            }
            let _ = parent_name;
            let link = ManagedLink {
                target: record
                    .target
                    .iter()
                    .fold(root.path.clone(), |p, c| p.join(c)),
                link: (id.dev, id.ino),
                source: (record.source.dev, record.source.ino),
            };
            link.verify(&path)?;
            links.insert(path, link);
        }
        // Validate the whole copy before accepting any disk journal into the capability cache.
        let mut count = 0;
        scan(&root.path, 0, &mut count, &links)?;
        *root.links.lock().map_err(|_| AccountError(UNSAFE))? = links;
        *root.journal.lock().map_err(|_| AccountError(UNSAFE))? = JournalState { data, bytes };
        Ok(())
    }
}
impl Writer {
    pub(crate) fn entry(&self, key: &str) -> Result<Option<Entry>> {
        self.verify()?;
        Ok(self
            .sandbox
            .0
            .journal
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .data
            .entries
            .get(key)
            .cloned())
    }
    pub(crate) fn journal_change(
        &self,
        change: impl FnOnce(&mut Journal) -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        let root = &self.sandbox.0;
        let mut next = root
            .journal
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .data
            .clone();
        change(&mut next)?;
        next.revision = next.revision.checked_add(1).ok_or(AccountError(UNSAFE))?;
        let bytes = journal::encode(&next, &root.journal_key)?;
        journal::checkpoint("journal-before-temp")?;
        let temp = format!(".preparation-{}.tmp", Uuid::new_v4());
        let mut file = open(
            &root.dir,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            file.write_all(&bytes).map_err(|_| AccountError(IO))?;
            file.sync_all().map_err(|_| AccountError(IO))?;
            journal::checkpoint("journal-temp-synced")?;
            self.verify()?;
            let from = CString::new(temp.as_str()).map_err(|_| AccountError(IO))?;
            let to = CString::new(journal::FILE).map_err(|_| AccountError(IO))?;
            if unsafe {
                libc::renameat(
                    root.dir.as_raw_fd(),
                    from.as_ptr(),
                    root.dir.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(AccountError(IO));
            }
            // Advance memory before a directory-sync error: disk has already atomically changed.
            *root.journal.lock().map_err(|_| AccountError(UNSAFE))? =
                JournalState { data: next, bytes };
            journal::checkpoint("journal-renamed")?;
            root.dir.sync_all().map_err(|_| AccountError(IO))?;
            journal::checkpoint("journal-directory-synced")?;
            Ok(())
        })();
        if result.is_err() {
            unlink_same(&root.dir, &temp, &file);
        }
        result
    }
    pub(crate) fn begin_plan(
        &self,
        key: &str,
        tag: String,
        steps: Vec<Step>,
        creation: Option<serde_json::Value>,
    ) -> Result<()> {
        if let Some(entry) = self.entry(key)? {
            if entry.tag != tag {
                return Err(AccountError(
                    "Pending synthetic source inputs differ from their saved preparation plan.",
                ));
            }
            return Ok(());
        }
        self.journal_change(|j| {
            j.entries.insert(
                key.into(),
                Entry {
                    tag,
                    steps,
                    next: 0,
                    complete: false,
                    creation: creation.map(|account| journal::Creation {
                        account,
                        publication: journal::Publication::Pending,
                    }),
                },
            );
            Ok(())
        })
    }
    pub(crate) fn creations(&self) -> Result<Vec<(String, Entry)>> {
        self.verify()?;
        Ok(self
            .sandbox
            .0
            .journal
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .data
            .entries
            .iter()
            .filter(|(_, e)| e.creation.is_some())
            .map(|(k, e)| (k.clone(), e.clone()))
            .collect())
    }
    pub(crate) fn forget_creation(&self, key: &str) -> Result<()> {
        let Some(entry) = self.entry(key)? else {
            return Ok(());
        };
        if entry.creation.is_none() {
            return Ok(());
        }
        self.journal_change(|j| {
            j.entries
                .get_mut(key)
                .and_then(|e| e.creation.as_mut())
                .ok_or(AccountError(UNSAFE))?
                .publication = journal::Publication::Removed;
            Ok(())
        })
    }
    pub(crate) fn run_plan(&self, key: &str) -> Result<()> {
        let mut entry = self
            .entry(key)?
            .ok_or(AccountError("No isolated preparation plan exists."))?;
        if entry
            .creation
            .as_ref()
            .is_some_and(|c| c.publication == journal::Publication::Removed)
        {
            return Err(AccountError(crate::MISSING_ACCOUNT));
        }
        if entry.complete {
            return Ok(());
        }
        // A changed already-written file is a conflict, not an excuse to overwrite it on retry.
        for step in entry.steps.iter().take(entry.next) {
            if let Step::File { path, text } = step {
                let (name, parts) = path.split_last().ok_or(AccountError(UNSAFE))?;
                if self.profile_read(&journal::refs(parts), name)?.as_deref() != Some(text) {
                    return Err(AccountError(
                        "A pending profile file differs from its saved preparation plan.",
                    ));
                }
            }
        }
        while entry.next < entry.steps.len() {
            journal::checkpoint("step-before")?;
            match &entry.steps[entry.next] {
                Step::Directory { path } => {
                    self.profile_directory(&journal::refs(path))?;
                    let dir = self.directory(&journal::refs(path), false)?;
                    dir.sync_all().map_err(|_| AccountError(IO))?;
                    if let Some((_, parent)) = path.split_last() {
                        self.directory(&journal::refs(parent), false)?
                            .sync_all()
                            .map_err(|_| AccountError(IO))?;
                    }
                    journal::checkpoint("directory-created")?;
                    let id = Identity::of(&dir.metadata().map_err(|_| AccountError(UNSAFE))?);
                    let name = path.join("/");
                    self.journal_change(|j| {
                        if j.dirs.get(&name).is_some_and(|old| *old != id) {
                            return Err(AccountError(UNSAFE));
                        }
                        j.dirs.insert(name, id);
                        Ok(())
                    })?;
                }
                Step::File { path, text } => {
                    let (name, parts) = path.split_last().ok_or(AccountError(UNSAFE))?;
                    let parts = journal::refs(parts);
                    match self.profile_read(&parts, name)? {
                        Some(before) if before != *text => {
                            return Err(AccountError(
                                "A pending profile file differs from its saved preparation plan.",
                            ))
                        }
                        Some(_) => {}
                        None => self.profile_write(&parts, name, text)?,
                    };
                    self.directory(&parts, false)?
                        .sync_all()
                        .map_err(|_| AccountError(IO))?;
                    journal::checkpoint("profile-file-published")?;
                }
                Step::Link { path, source } => {
                    let name = path.join("/");
                    let dir = self.directory(&journal::refs(source), false)?;
                    let id = Identity::of(&dir.metadata().map_err(|_| AccountError(UNSAFE))?);
                    self.journal_change(|j| {
                        if let Some(old) = j.links.get(&name) {
                            if old.target != *source || old.source != id {
                                return Err(AccountError(UNSAFE));
                            }
                        } else {
                            j.links.insert(
                                name.clone(),
                                journal::Link {
                                    target: source.clone(),
                                    source: id,
                                    inode: None,
                                },
                            );
                        }
                        Ok(())
                    })?;
                    self.profile_link(&journal::refs(path), &journal::refs(source))?;
                    self.directory(&journal::refs(&path[..path.len() - 1]), false)?
                        .sync_all()
                        .map_err(|_| AccountError(IO))?;
                    journal::checkpoint("profile-link-created")?;
                    let at = self.root_path().join(&name);
                    let inode =
                        Identity::of(&fs::symlink_metadata(at).map_err(|_| AccountError(UNSAFE))?);
                    self.journal_change(|j| {
                        j.links.get_mut(&name).ok_or(AccountError(UNSAFE))?.inode = Some(inode);
                        Ok(())
                    })?;
                }
            }
            entry.next += 1;
            self.journal_change(|j| {
                j.entries.get_mut(key).ok_or(AccountError(UNSAFE))?.next = entry.next;
                Ok(())
            })?;
            journal::checkpoint("step-recorded")?;
        }
        self.journal_change(|j| {
            j.entries.get_mut(key).ok_or(AccountError(UNSAFE))?.complete = true;
            Ok(())
        })?;
        journal::checkpoint("plan-complete")?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod recovery_tests;
