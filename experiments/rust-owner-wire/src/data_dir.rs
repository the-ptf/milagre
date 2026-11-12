//! A Milagre data directory's own socket, for an owner that holds the directory's Node-format `runtime.lock`.
//!
//! The Node daemon binds `/tmp/milagre-<uid>/<sha256(realpath(dataDir))[..24]>.sock` (`apps/daemon/src/paths.cjs`)
//! after `createRuntime` took `realpath(dataDir)/runtime.lock`, and removes a socket file it finds there first: the
//! lock proves no other owner of that directory is alive. [`DataDirEndpoint`] is the same endpoint for a Rust owner.
//! It is built only with proof of that lock: `runtime.lock/owner.json` must be a plain file naming this process and the
//! caller's token. A stale endpoint is removed only while that proof still holds, and only when it is a socket owned by
//! this user; anything else in the way is refused and left as it is.
//!
//! This module never takes, creates or removes a lock, and never connects to an endpoint. Which data directories an
//! owner may claim (an isolated copy only, never a live profile) is the owner's decision, made before it takes the lock.
use crate::RpcError;
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    io::Read,
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt},
    path::{Component, Path, PathBuf},
};

const OWNER_RECORD_LIMIT: u64 = 64 * 1024;

/// `path.resolve` for an absolute path: `.` and `..` folded, no trailing slash, the file system untouched.
fn resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// Node's `fs.realpathSync` (the JavaScript one paths.cjs calls, not `.native`): every symbolic link on the path
/// resolved, every other part kept as spelled. On a case-insensitive volume `realpath(3)` returns the case on disk
/// instead, so the two derive different sockets for a path spelled in another case; this one is Node's.
pub fn node_realpath(path: &Path) -> io::Result<PathBuf> {
    let mut current = resolve(path);
    let mut links = 0;
    'walk: loop {
        let mut walked = PathBuf::from("/");
        let parts: Vec<_> = current.components().skip(1).collect();
        for (index, part) in parts.iter().enumerate() {
            walked.push(part);
            if fs::symlink_metadata(&walked)?.file_type().is_symlink() {
                links += 1;
                if links > 40 {
                    return Err(io::Error::from_raw_os_error(libc::ELOOP));
                }
                let target = fs::read_link(&walked)?;
                let mut next = walked.parent().unwrap_or(Path::new("/")).join(target);
                for rest in &parts[index + 1..] {
                    next.push(rest);
                }
                current = resolve(&next);
                continue 'walk;
            }
        }
        return Ok(current);
    }
}

/// The socket path the Node daemon derives for `data_dir` (`apps/daemon/src/paths.cjs` socketPath: the SHA-256 of
/// `fs.realpathSync(dataDir)`, see [`node_realpath`]). The directory must exist. Creates nothing.
pub fn socket_path_for(data_dir: &Path) -> Result<PathBuf, RpcError> {
    if !data_dir.is_absolute() {
        return Err(RpcError::new(
            "INVALID_DATA_DIR",
            "Pass an absolute --data-dir",
        ));
    }
    let real = node_realpath(data_dir)?;
    let digest = hex::encode(Sha256::digest(real.as_os_str().as_encoded_bytes()));
    Ok(socket_directory().join(format!("{}.sock", &digest[..24])))
}

fn socket_directory() -> PathBuf {
    PathBuf::from(format!("/tmp/milagre-{}", unsafe { libc::getuid() }))
}

/// paths.cjs prepareSocketDirectory: made 0700 when missing, and refused unless it is a real folder owned by this user
/// with mode 0700. An existing folder is never chmodded.
pub(crate) fn prepare_socket_directory(directory: &Path) -> Result<(), RpcError> {
    match fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let meta = fs::symlink_metadata(directory)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(RpcError::new(
            "UNSAFE_SOCKET",
            "The daemon socket directory must be owned by you with mode 0700",
        ));
    }
    Ok(())
}

/// The endpoint of a data directory whose `runtime.lock` this process holds. There is no constructor without the lock's
/// token, and nothing here can take or create a lock.
pub struct DataDirEndpoint {
    data_dir: PathBuf,
    socket: PathBuf,
    version: String,
    token: String,
}

impl DataDirEndpoint {
    /// `data_dir` is canonicalized (status reports the real path, as the Node daemon's clients compare it). `lock_token`
    /// is the token of the `runtime.lock` this process took in that directory; `version` is what `daemon:status`
    /// reports (the Node daemon's `--app-version`).
    pub fn claim(data_dir: &Path, lock_token: &str, version: &str) -> Result<Self, RpcError> {
        if version.is_empty()
            || version.len() > 256
            || version.chars().any(char::is_control)
            || lock_token.is_empty()
        {
            return Err(RpcError::new(
                "INVALID_CONFIG",
                "A data directory endpoint needs a version and its lock's token",
            ));
        }
        let socket = socket_path_for(data_dir)?;
        let endpoint = Self {
            data_dir: fs::canonicalize(data_dir)?,
            socket,
            version: version.to_owned(),
            token: lock_token.to_owned(),
        };
        endpoint.verify_lock()?;
        Ok(endpoint)
    }
    pub fn path(&self) -> &Path {
        &self.data_dir
    }
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }
    pub fn version(&self) -> &str {
        &self.version
    }
    /// The data directory is still the one claimed and its `runtime.lock` still names this process with the claimed
    /// token: a real folder holding a plain, singly linked `owner.json`.
    pub fn verify_lock(&self) -> Result<(), RpcError> {
        let refuse = |why: &str| {
            RpcError::new(
                "DATA_DIR_NOT_OWNED",
                format!("This process doesn't own the data directory's runtime.lock: {why}"),
            )
        };
        if fs::canonicalize(&self.data_dir).ok().as_deref() != Some(self.data_dir.as_path()) {
            return Err(refuse("the data directory moved"));
        }
        let lock = self.data_dir.join("runtime.lock");
        match fs::symlink_metadata(&lock) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(refuse("the lock isn't a folder")),
            Err(_) => return Err(refuse("there is no lock")),
        }
        let record = lock.join("owner.json");
        let meta = fs::symlink_metadata(&record).map_err(|_| refuse("its owner record is gone"))?;
        if !meta.is_file() || meta.nlink() != 1 || meta.len() > OWNER_RECORD_LIMIT {
            return Err(refuse("its owner record isn't a plain file"));
        }
        let mut bytes = Vec::new();
        fs::File::open(&record)
            .and_then(|file| file.take(OWNER_RECORD_LIMIT + 1).read_to_end(&mut bytes))
            .map_err(|_| refuse("its owner record can't be read"))?;
        let owner: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| refuse("its owner record isn't JSON"))?;
        if owner["pid"].as_u64() != Some(u64::from(std::process::id())) {
            return Err(refuse("its owner record names another process"));
        }
        if owner["token"].as_str() != Some(self.token.as_str()) {
            return Err(refuse("its owner record holds another token"));
        }
        Ok(())
    }
    /// server.cjs: with the data directory owned, a socket file at its path is one a crashed owner left. Removed only
    /// while the lock still proves this process owns the directory, and only when it is a socket owned by this user.
    pub(crate) fn remove_stale_socket(&self) -> Result<(), RpcError> {
        let meta = match fs::symlink_metadata(&self.socket) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::getuid() } {
            return Err(RpcError::new(
                "UNSAFE_SOCKET",
                "Something other than your daemon socket is at this data directory's socket path; it was left as it is",
            ));
        }
        self.verify_lock()?;
        match fs::remove_file(&self.socket) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn lock(dir: &Path, pid: u32, token: &str) {
        fs::create_dir_all(dir.join("runtime.lock")).unwrap();
        fs::write(
            dir.join("runtime.lock/owner.json"),
            serde_json::json!({"pid": pid, "token": token}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn socket_path_is_the_node_derivation_of_the_real_path() {
        let base = tempfile::tempdir().unwrap();
        let real = fs::canonicalize(base.path()).unwrap();
        let digest = hex::encode(Sha256::digest(real.as_os_str().as_encoded_bytes()));
        let expected = socket_directory().join(format!("{}.sock", &digest[..24]));
        assert_eq!(socket_path_for(base.path()).unwrap(), expected);
        // A symbolic link to the folder derives the same endpoint, as fs.realpathSync does.
        let alias = base.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(socket_path_for(&alias).unwrap(), expected);
        assert!(socket_path_for(Path::new("relative")).is_err());
        // Links resolve (relative ones and `..` after them too); the rest keeps its spelling, as Node's does.
        std::fs::create_dir(real.join("Inner")).unwrap();
        std::os::unix::fs::symlink("Inner/../Inner", real.join("rel")).unwrap();
        assert_eq!(
            node_realpath(&real.join("rel/./")).unwrap(),
            real.join("Inner")
        );
        assert_eq!(
            node_realpath(&real.join("Inner/x/..")).unwrap(),
            real.join("Inner")
        );
        if real.join("INNER").is_dir() {
            assert_eq!(
                node_realpath(&real.join("INNER")).unwrap(),
                real.join("INNER")
            );
        }
        std::os::unix::fs::symlink("loop", real.join("loop")).unwrap();
        assert!(node_realpath(&real.join("loop")).is_err());
        assert!(node_realpath(&real.join("missing")).is_err());
    }

    #[test]
    fn claim_needs_this_process_and_token_in_the_lock() {
        let base = tempfile::tempdir().unwrap();
        let dir = base.path();
        let missing = DataDirEndpoint::claim(dir, "t", "1.0.0").err().unwrap();
        assert_eq!(missing.code, "DATA_DIR_NOT_OWNED");
        lock(dir, std::process::id() + 1, "t");
        assert!(DataDirEndpoint::claim(dir, "t", "1.0.0")
            .err()
            .unwrap()
            .message
            .contains("another process"));
        fs::remove_dir_all(dir.join("runtime.lock")).unwrap();
        lock(dir, std::process::id(), "t");
        assert!(DataDirEndpoint::claim(dir, "other", "1.0.0")
            .err()
            .unwrap()
            .message
            .contains("another token"));
        assert_eq!(
            DataDirEndpoint::claim(dir, "t", "").err().unwrap().code,
            "INVALID_CONFIG"
        );
        let endpoint = DataDirEndpoint::claim(dir, "t", "1.0.0").unwrap();
        assert_eq!(endpoint.path(), fs::canonicalize(dir).unwrap());
        // A lock replaced after the claim is noticed before anything is removed.
        fs::write(
            dir.join("runtime.lock/owner.json"),
            serde_json::json!({"pid": std::process::id(), "token": "x"}).to_string(),
        )
        .unwrap();
        assert!(endpoint.verify_lock().is_err());
    }

    #[test]
    fn a_linked_lock_or_record_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let elsewhere = base.path().join("elsewhere");
        let dir = base.path().join("data");
        fs::create_dir_all(&dir).unwrap();
        lock(&elsewhere, std::process::id(), "t");
        std::os::unix::fs::symlink(elsewhere.join("runtime.lock"), dir.join("runtime.lock"))
            .unwrap();
        assert!(DataDirEndpoint::claim(&dir, "t", "1").is_err());
        fs::remove_file(dir.join("runtime.lock")).unwrap();
        fs::create_dir(dir.join("runtime.lock")).unwrap();
        fs::hard_link(
            elsewhere.join("runtime.lock/owner.json"),
            dir.join("runtime.lock/owner.json"),
        )
        .unwrap();
        assert!(DataDirEndpoint::claim(&dir, "t", "1").is_err());
    }

    #[test]
    fn only_a_stale_socket_of_this_user_is_removed() {
        let base = tempfile::tempdir().unwrap();
        lock(base.path(), std::process::id(), "t");
        let endpoint = DataDirEndpoint::claim(base.path(), "t", "1").unwrap();
        prepare_socket_directory(&socket_directory()).unwrap();
        // Nothing there: nothing to do.
        endpoint.remove_stale_socket().unwrap();
        // A regular file is never removed.
        fs::write(endpoint.socket_path(), "sentinel").unwrap();
        assert_eq!(
            endpoint.remove_stale_socket().err().unwrap().code,
            "UNSAFE_SOCKET"
        );
        assert_eq!(
            fs::read_to_string(endpoint.socket_path()).unwrap(),
            "sentinel"
        );
        fs::remove_file(endpoint.socket_path()).unwrap();
        // A socket left behind is removed while the lock holds, and kept when it doesn't.
        drop(UnixListener::bind(endpoint.socket_path()).unwrap());
        fs::write(
            base.path().join("runtime.lock/owner.json"),
            serde_json::json!({"pid": std::process::id(), "token": "x"}).to_string(),
        )
        .unwrap();
        assert!(endpoint.remove_stale_socket().is_err());
        assert!(fs::symlink_metadata(endpoint.socket_path()).is_ok());
        fs::write(
            base.path().join("runtime.lock/owner.json"),
            serde_json::json!({"pid": std::process::id(), "token": "t"}).to_string(),
        )
        .unwrap();
        endpoint.remove_stale_socket().unwrap();
        assert!(fs::symlink_metadata(endpoint.socket_path()).is_err());
    }
}
