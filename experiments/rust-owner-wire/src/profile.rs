use crate::RpcError;
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    os::fd::AsRawFd,
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
};
use tempfile::TempDir;

/// A new private throwaway profile. There is intentionally no constructor from an existing path.
pub struct IsolatedProfile {
    directory: TempDir,
    pub(crate) socket: PathBuf,
}
impl IsolatedProfile {
    pub fn create() -> Result<Self, RpcError> {
        let directory = tempfile::Builder::new()
            .prefix("milagre-rust-wire-")
            .tempdir()?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
        let real = fs::canonicalize(directory.path())?;
        let digest = hex::encode(Sha256::digest(real.as_os_str().as_encoded_bytes()));
        let parent = PathBuf::from(format!("/tmp/milagre-{}", unsafe { libc::getuid() }));
        match fs::DirBuilder::new().mode(0o700).create(&parent) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let meta = fs::symlink_metadata(&parent)?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o777 != 0o700
        {
            return Err(RpcError::new(
                "UNSAFE_SOCKET",
                "The daemon socket directory must be owned by you with mode 0700",
            ));
        }
        Ok(Self {
            directory,
            socket: parent.join(format!("{}.sock", &digest[..24])),
        })
    }
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }
}

pub(crate) fn assert_same_user(socket: &UnixStream) -> Result<(), RpcError> {
    #[cfg(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    let uid = {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        uid
    };
    #[cfg(target_os = "linux")]
    let uid = {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut size,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        credentials.uid
    };
    #[cfg(not(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "linux"
    )))]
    compile_error!(
        "Peer credential verification must be implemented before enabling this platform"
    );
    if uid != unsafe { libc::getuid() } {
        return Err(RpcError::new(
            "UNAUTHORIZED",
            "The daemon accepts only the same OS user",
        ));
    }
    Ok(())
}
