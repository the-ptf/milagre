use serde_json::Value;
use std::{
    ffi::CString,
    fs::File,
    io,
    os::unix::{
        fs::{FileExt, MetadataExt},
        io::{AsRawFd, FromRawFd},
    },
    path::{Component, Path},
    sync::Arc,
};
pub const MAX_FILE: u64 = 64 * 1024;
fn open(parent: &File, name: &str, directory: bool) -> io::Result<File> {
    let name = CString::new(name)?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn stamp(file: &File) -> io::Result<(u64, u64)> {
    let m = file.metadata()?;
    Ok((m.dev(), m.ino()))
}
type Ancestor = (Arc<File>, String, (u64, u64));
/// Retains every ancestor descriptor, not only a path or its final inode.
#[derive(Clone)]
pub struct Directory {
    file: Arc<File>,
    chain: Arc<Vec<Ancestor>>,
}
impl Directory {
    pub fn pin(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::other("absolute fixture path required"));
        }
        let mut file = Arc::new(File::open("/")?);
        let mut chain = Vec::new();
        for component in path.components() {
            let name = match component {
                Component::RootDir => continue,
                Component::Normal(n) => n.to_str().ok_or_else(|| io::Error::other("non-UTF8 fixture path"))?,
                _ => return Err(io::Error::other("invalid fixture component")),
            };
            let child = Arc::new(open(&file, name, true)?);
            chain.push((file, name.into(), stamp(&child)?));
            file = child;
        }
        Ok(Self { file, chain: Arc::new(chain) })
    }
    pub fn check(&self) -> io::Result<()> {
        for (parent, name, expected) in self.chain.iter() {
            if stamp(&open(parent, name, true)?)? != *expected {
                return Err(io::Error::other("fixture directory replaced"));
            }
        }
        Ok(())
    }
    pub fn fixture(&self, bytes: &[u8]) -> io::Result<FixtureFile> {
        self.check()?;
        let file = open(&self.file, "quota.json", false)?;
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 || m.len() > MAX_FILE {
            return Err(io::Error::other("invalid fixture file"));
        }
        Ok(FixtureFile { directory: self.clone(), stamp: stamp(&file)?, file, bytes: bytes.to_vec() })
    }
}
pub struct FixtureFile {
    directory: Directory,
    file: File,
    stamp: (u64, u64),
    bytes: Vec<u8>,
}
impl FixtureFile {
    pub fn check(&self) -> io::Result<()> {
        self.directory.check()?;
        let current = open(&self.directory.file, "quota.json", false)?;
        let m = current.metadata()?;
        if stamp(&current)? != self.stamp || !m.is_file() || m.nlink() != 1 || m.len() != self.bytes.len() as u64 {
            return Err(io::Error::other("fixture file replaced or changed"));
        }
        Ok(())
    }
    pub fn read(&self) -> io::Result<Value> {
        self.check()?;
        let mut bytes = vec![0; self.bytes.len()];
        self.file.read_exact_at(&mut bytes, 0)?;
        self.check()?;
        if bytes != self.bytes {
            return Err(io::Error::other("fixture contents changed"));
        }
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaced_linked_and_mutated_files_are_rejected() {
        for kind in 0..4 {
            let temp = tempfile::tempdir_in("/tmp").unwrap();
            let root = std::fs::canonicalize(temp.path()).unwrap();
            let path = root.join("quota.json");
            let bytes = b"{\"value\":1}";
            std::fs::write(&path, bytes).unwrap();
            let directory = Directory::pin(&root).unwrap();
            let pinned = directory.fixture(bytes).unwrap();
            assert_eq!(pinned.read().unwrap(), serde_json::json!({"value":1}));
            if kind == 3 {
                std::fs::write(&path, b"{\"value\":2}").unwrap();
            } else {
                std::fs::rename(&path, root.join("old")).unwrap();
                match kind {
                    0 => std::fs::write(&path, bytes).unwrap(),
                    1 => std::os::unix::fs::symlink(root.join("old"), &path).unwrap(),
                    2 => std::fs::hard_link(root.join("old"), &path).unwrap(),
                    _ => unreachable!(),
                }
            }
            assert!(pinned.read().is_err());
        }
    }
}
