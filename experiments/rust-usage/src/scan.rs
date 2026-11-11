//! Read-only scanner over explicitly supplied copies. No defaults, home discovery or cache-file writes.
//! On Unix every path component is opened relative to a directory fd with O_NOFOLLOW.
use crate::transcript::{rows, Entry};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone)]
pub struct ScanCancellation {
    cancelled: Arc<AtomicBool>,
    #[cfg(test)]
    chunks: Arc<std::sync::atomic::AtomicUsize>,
}
impl Default for ScanCancellation {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            chunks: Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX)),
        }
    }
}
impl ScanCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    fn check(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(io::Error::new(io::ErrorKind::Interrupted, "copied-root scan cancelled"))
        } else {
            Ok(())
        }
    }
    #[cfg(test)]
    pub(crate) fn test_cancel_after_chunks(&self, chunks: usize) {
        self.chunks.store(chunks, Ordering::SeqCst);
    }
    fn chunk_complete(&self) -> io::Result<()> {
        #[cfg(test)]
        if self.chunks.load(Ordering::SeqCst) != usize::MAX && self.chunks.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.cancel();
        }
        self.check()
    }
}

#[derive(Clone, Debug)]
pub struct CopiedRoot {
    provider: String,
    dir: PathBuf,
}
impl CopiedRoot {
    pub fn new(provider: &str, dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        if !["claude", "codex"].contains(&provider) || !dir.is_absolute() || dir.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "explicit absolute copied transcript root required"));
        }
        Ok(Self { provider: provider.into(), dir })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanCache {
    pub version: u32,
    pub files: IndexMap<String, Entry>,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}
impl Default for ScanCache {
    fn default() -> Self {
        Self { version: 3, files: IndexMap::new(), finished_at: None }
    }
}
impl ScanCache {
    pub fn from_json(v: Value) -> Self {
        Self::validated(v).unwrap_or_default()
    }
    pub(crate) fn validated(v: Value) -> Option<Self> {
        serde_json::from_value::<Self>(v).ok().filter(|c| {
            c.version == 3
                && c.files.values().all(|e| {
                    e.carry.is_object() && e.sessions.values().all(Value::is_object) && ["claude", "codex"].contains(&e.provider.as_str())
                })
        })
    }
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("cache serializes")
    }
}
/// Synchronous, single-owner scanner. Run on the runtime's blocking pool. Export/import cache JSON explicitly.
pub struct Scanner {
    roots: Vec<CopiedRoot>,
    cache: ScanCache,
    scanned_at: i64,
}
impl Scanner {
    pub fn new(roots: Vec<CopiedRoot>, cache: ScanCache) -> Self {
        Self { roots, cache, scanned_at: 0 }
    }
    /// Restore a verified snapshot without losing deleted-file history or changing authorized roots.
    pub(crate) fn restore_after_panic(&mut self, last_good: ScanCache) {
        self.cache = last_good;
        self.scanned_at = 0;
    }
    pub fn rows(&self) -> Value {
        rows(&self.cache.files)
    }
    pub fn cache(&self) -> &ScanCache {
        &self.cache
    }
    pub fn finished(&self) -> bool {
        self.cache.finished_at.is_some_and(|at| at != 0)
    }
    pub fn scanned_at(&self) -> i64 {
        self.scanned_at
    }
    pub fn scan(&mut self, now: i64) -> io::Result<bool> {
        self.scan_cancellable(now, &ScanCancellation::default())
    }
    pub fn scan_cancellable(&mut self, now: i64, cancel: &ScanCancellation) -> io::Result<bool> {
        cancel.check()?;
        #[cfg(not(unix))]
        {
            let _ = now;
            Err(io::Error::new(io::ErrorKind::Unsupported, "copied-profile scanning requires Unix directory handles"))
        }
        #[cfg(unix)]
        {
            let mut changed = false;
            let mut seen = std::collections::HashSet::new();
            for root in &self.roots {
                cancel.check()?;
                let directory = match open_absolute_directory(&root.dir) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let mut files = Vec::new();
                walk(&directory, Path::new(""), 5, &mut files, cancel)?;
                for relative in files {
                    cancel.check()?;
                    let id = if root.provider == "claude" {
                        format!("claude:{}", relative.display())
                    } else {
                        format!("codex:{}", relative.file_name().unwrap().to_string_lossy())
                    };
                    if !seen.insert(id.clone()) {
                        continue;
                    }
                    let mut file = match open_relative(&directory, &relative) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    let stats = file.metadata()?;
                    if !stats.is_file() {
                        continue;
                    }
                    let size = stats.len();
                    let full = root.dir.join(&relative).to_string_lossy().into_owned();
                    if self.cache.files.get(&id).is_some_and(|e| size < e.offset) {
                        self.cache.files.insert(id.clone(), Entry::new(&root.provider));
                    }
                    let entry = self.cache.files.entry(id).or_insert_with(|| Entry::new(&root.provider));
                    if entry.file.as_deref() == Some(&full) && entry.offset == size {
                        continue;
                    }
                    entry.file = Some(full);
                    if entry.offset < size {
                        read_from(&mut file, entry, size, cancel)?;
                    }
                    entry.prune(now);
                    changed = true;
                }
            }
            cancel.check()?;
            self.scanned_at = now;
            if !self.finished() {
                changed = true;
            }
            self.cache.finished_at = Some(now);
            Ok(changed)
        }
    }
}
fn read_from(file: &mut File, entry: &mut Entry, size: u64, cancel: &ScanCancellation) -> io::Result<()> {
    file.seek(SeekFrom::Start(entry.offset))?;
    let mut remaining = size - entry.offset;
    let mut pending = Vec::new();
    let mut chunk = vec![0; 4 * 1024 * 1024];
    while remaining > 0 {
        cancel.check()?;
        let want = (remaining as usize).min(chunk.len());
        let count = file.read(&mut chunk[..want])?;
        if count == 0 {
            break;
        }
        remaining -= count as u64;
        pending.extend_from_slice(&chunk[..count]);
        if let Some(last) = pending.iter().rposition(|b| *b == b'\n') {
            entry.feed(&pending[..=last]);
            entry.offset += (last + 1) as u64;
            pending.drain(..=last);
        }
        cancel.chunk_complete()?;
    }
    Ok(())
}
#[cfg(unix)]
fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL path"))?;
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
#[cfg(unix)]
fn open_absolute_directory(path: &Path) -> io::Result<File> {
    let mut dir = File::open("/")?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(name) => dir = open_at(&dir, name, true)?,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "non-normal copied root")),
        }
    }
    Ok(dir)
}
#[cfg(unix)]
fn open_relative(dir: &File, path: &Path) -> io::Result<File> {
    let mut current = dir.try_clone()?;
    let parts: Vec<_> = path.components().collect();
    for (i, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else { return Err(io::Error::new(io::ErrorKind::InvalidInput, "non-normal transcript path")) };
        current = open_at(&current, name, i + 1 < parts.len())?;
    }
    Ok(current)
}
#[cfg(unix)]
fn walk(dir: &File, relative: &Path, depth: usize, found: &mut Vec<PathBuf>, cancel: &ScanCancellation) -> io::Result<()> {
    cancel.check()?;
    use std::os::unix::ffi::OsStrExt;
    // fdopendir takes ownership of its fd; open '.' for an independent directory cursor.
    let Ok(cursor) = open_at(dir, std::ffi::OsStr::new("."), true) else { return Ok(()) };
    use std::os::fd::IntoRawFd;
    let fd = cursor.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Ok(());
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    let mut names = Vec::new();
    loop {
        cancel.check()?;
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            names.push(std::ffi::OsStr::from_bytes(name).to_os_string());
        }
    }
    drop(stream);
    names.sort();
    for name in names {
        cancel.check()?;
        let path = relative.join(&name);
        let Ok(child) = open_at(dir, &name, false) else { continue };
        let Ok(meta) = child.metadata() else { continue };
        if meta.is_dir() && depth > 0 {
            walk(&child, &path, depth - 1, found, cancel)?;
        } else if meta.is_file() && name.to_string_lossy().ends_with(".jsonl") {
            found.push(path);
        }
    }
    Ok(())
}
/// Helper for the runtime's token-usage:read envelope. Scheduling and event emission belong to the owner.
pub fn report_envelope(mut report: Value, refreshing: bool, first_scan: bool, pricing: Value) -> Value {
    report["refreshing"] = json!(refreshing);
    report["firstScan"] = json!(first_scan);
    report["pricing"] = pricing;
    report
}
