//! Fresh-copy capability and descriptor-relative atomic metadata storage (Unix only).
use crate::{AccountError, Accounts, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
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
    marker: String,
    links: Mutex<BTreeMap<PathBuf, ManagedLink>>,
    prepared: Mutex<BTreeSet<String>>,
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
        // No recursive destructor: a later path replacement must never cause deletion of someone
        // else's files. Tests remove their known copies explicitly after dropping every handle.
        let _ = temp.keep();
        let result = Self(Arc::new(Root {
            path,
            dir,
            accounts,
            marker,
            links: Mutex::new(BTreeMap::new()),
            prepared: Mutex::new(BTreeSet::new()),
        }));
        result.verify()?;
        Ok(result)
    }
    /// Diagnostic/test path only. Mutations never accept caller paths and use pinned descriptors.
    pub fn path(&self) -> &Path {
        &self.0.path
    }
    pub(crate) fn acquire(&self) -> Result<Writer> {
        self.verify()?;
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
        let writer = Writer {
            sandbox: self.clone(),
            lock,
            _root_lock: root_lock,
            expected: read_optional(&self.0.accounts, META)?,
        };
        writer.verify()?;
        Ok(writer)
    }
    fn verify(&self) -> Result<()> {
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
        let marker = read_optional(&root.dir, MARKER)?.ok_or(AccountError(UNSAFE))?;
        if marker != root.marker.as_bytes() {
            return Err(AccountError(UNSAFE));
        }
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
        let mut file = open(
            dir,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            file.write_all(&bytes).map_err(|_| AccountError(IO))?;
            file.sync_all().map_err(|_| AccountError(IO))?;
            before_rename()?;
            self.verify()?;
            let from = CString::new(name.as_str()).map_err(|_| AccountError(IO))?;
            let to = CString::new(META).map_err(|_| AccountError(IO))?;
            // SAFETY: both names are validated NUL-free constants/generated names in the same held dir.
            if unsafe {
                libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr())
            } != 0
            {
                return Err(AccountError(IO));
            }
            Ok(())
        })();
        if result.is_err() {
            unlink_same(dir, &name, &file);
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
    if before.len() > 4 * 1024 * 1024 {
        return Err(AccountError(crate::READ_ERROR));
    }
    let mut body = Vec::new();
    Read::by_ref(&mut file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut body)
        .map_err(|_| AccountError(crate::READ_ERROR))?;
    if body.len() > 4 * 1024 * 1024 {
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
            .prepared
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .contains(key))
    }
    pub(crate) fn mark_prepared(&self, key: &str) -> Result<()> {
        self.verify()?;
        self.sandbox
            .0
            .prepared
            .lock()
            .map_err(|_| AccountError(UNSAFE))?
            .insert(key.to_owned());
        Ok(())
    }
    // All callers supply fixed components or an already validated account UUID. No caller paths.
    fn directory(&self, parts: &[&str], create: bool) -> Result<File> {
        let mut dir = self
            .sandbox
            .0
            .dir
            .try_clone()
            .map_err(|_| AccountError(IO))?;
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
        let temp = format!(".profile-{}.tmp", Uuid::new_v4());
        let mut file = open(
            &dir,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            file.write_all(text.as_bytes())
                .map_err(|_| AccountError(IO))?;
            file.sync_all().map_err(|_| AccountError(IO))?;
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
                libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr())
            } != 0
            {
                return Err(AccountError(IO));
            }
            Ok(())
        })();
        if result.is_err() {
            unlink_same(&dir, &temp, &file);
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
