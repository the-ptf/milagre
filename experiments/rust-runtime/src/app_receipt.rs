//! Informational receipt from an already-owned fresh server, never an endpoint constructor.
use milagre_owner_wire::{RpcError, Server};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

/// Includes the trailing newline written by the binary.
pub const MAX_BOOTSTRAP_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    socket: bool,
}
impl Identity {
    fn read(path: &Path, socket: bool) -> Result<Self, RpcError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.uid() != unsafe { libc::getuid() }
            || if socket {
                !metadata.file_type().is_socket()
            } else {
                !metadata.is_dir()
            }
        {
            return Err(invalid());
        }
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            socket,
        })
    }
    fn value(&self) -> Value {
        // IDs are decimal strings: JavaScript numbers cannot represent every u64 inode.
        json!({"dev":self.dev.to_string(),"ino":self.ino.to_string(),"mode":self.mode,"uid":self.uid,"kind":if self.socket {"socket"} else {"directory"}})
    }
}
struct Pinned {
    path: PathBuf,
    identity: Identity,
}
impl Pinned {
    fn capture(path: &Path, socket: bool) -> Result<Self, RpcError> {
        let identity = Identity::read(path, socket)?;
        let real = fs::canonicalize(path)?;
        let value = Self {
            path: real,
            identity,
        };
        value.check()?;
        Ok(value)
    }
    fn check(&self) -> Result<(), RpcError> {
        if Identity::read(&self.path, self.identity.socket)? != self.identity
            || fs::canonicalize(&self.path)? != self.path
        {
            return Err(invalid());
        }
        Ok(())
    }
}
fn invalid() -> RpcError {
    RpcError::new(
        "FIXTURE_BOOTSTRAP_INVALID",
        "Fresh fixture endpoint identity changed or is unsafe",
    )
}

/// Emits bounded metadata for an existing fresh owner. The caller must still authenticate
/// its fixed child, independently stat paths and verify peer credentials before connecting.
/// No receipt parser or constructor accepting an arbitrary endpoint is provided here.
pub fn bootstrap_receipt(server: &Server, actor: Value) -> Result<String, RpcError> {
    let project = actor["project"].as_str().ok_or_else(invalid)?;
    if Path::new(project) != server.profile_path().join("fixture")
        || actor["appFixture"] != true
        || actor["provider"] != "kiro"
        || actor["scriptedProvider"] != true
        || actor["handoff"] != "gated"
        || actor["steering"] != "gated"
    {
        return Err(invalid());
    }
    let profile = Pinned::capture(server.profile_path(), false)?;
    let project = Pinned::capture(Path::new(project), false)?;
    let socket_directory =
        Pinned::capture(server.socket_path().parent().ok_or_else(invalid)?, false)?;
    let socket = Pinned::capture(server.socket_path(), true)?;
    if profile.path != server.profile_path()
        || project.path.parent() != Some(profile.path.as_path())
        || socket.path.parent() != Some(socket_directory.path.as_path())
        || profile.identity.mode != 0o700
        || socket_directory.identity.mode != 0o700
        || socket.identity.mode != 0o600
    {
        return Err(invalid());
    }
    let value = json!({"profile":server.profile_path(),"socket":server.socket_path(),"fixture":true,"scriptedOwner":true,"bootstrapVersion":1,"protocolVersion":1,"pid":std::process::id(),"uid":unsafe { libc::getuid() },"appFixture":true,"ownedCopies":true,"actor":actor,"identities":{"profile":profile.identity.value(),"project":project.identity.value(),"socketDirectory":socket_directory.identity.value(),"socket":socket.identity.value()}});
    let line = serde_json::to_string(&value).map_err(|_| invalid())?;
    if line.len() + 1 > MAX_BOOTSTRAP_BYTES {
        return Err(RpcError::new(
            "FIXTURE_BOOTSTRAP_TOO_LARGE",
            "Fixture receipt exceeds 4096 bytes including newline",
        ));
    }
    for pinned in [&profile, &project, &socket_directory, &socket] {
        pinned.check()?;
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixListener,
    };

    #[test]
    fn pinned_identity_rejects_directory_socket_mode_and_symlink_replacement() {
        let temp = milagre_owner_wire::IsolatedProfile::create().unwrap();
        let directory = temp.path().join("directory");
        fs::create_dir(&directory).unwrap();
        let pinned = Pinned::capture(&directory, false).unwrap();
        pinned.check().unwrap();
        let held = temp.path().join("held");
        fs::rename(&directory, &held).unwrap();
        fs::create_dir(&directory).unwrap();
        assert!(pinned.check().is_err());
        fs::remove_dir(&directory).unwrap();
        symlink(&held, &directory).unwrap();
        assert!(pinned.check().is_err());
        assert!(Pinned::capture(&directory, false).is_err());
        fs::remove_file(&directory).unwrap();
        fs::rename(&held, &directory).unwrap();
        pinned.check().unwrap();
        let changed = pinned.identity.mode ^ 0o100;
        fs::set_permissions(&directory, fs::Permissions::from_mode(changed)).unwrap();
        assert!(pinned.check().is_err());
        let socket = temp.path().join("socket");
        let first = UnixListener::bind(&socket).unwrap();
        let pinned = Pinned::capture(&socket, true).unwrap();
        fs::rename(&socket, temp.path().join("old-socket")).unwrap();
        let _second = UnixListener::bind(&socket).unwrap();
        assert!(pinned.check().is_err());
        drop(first);
    }

    #[test]
    fn receipt_is_bounded_and_rejects_wrong_project_or_fixture_flags() {
        let (server, actor) = crate::app_fixture::start().unwrap();
        let server = std::sync::Arc::new(server);
        let receipt = bootstrap_receipt(&server, actor.clone()).unwrap();
        assert!(receipt.len() < MAX_BOOTSTRAP_BYTES);
        let mut oversized = actor.clone();
        oversized["extra"] = json!("x".repeat(MAX_BOOTSTRAP_BYTES));
        assert_eq!(
            bootstrap_receipt(&server, oversized).unwrap_err().code,
            "FIXTURE_BOOTSTRAP_TOO_LARGE"
        );
        for (key, value) in [
            ("project", json!("/tmp")),
            ("handoff", json!("restore")),
            ("appFixture", json!(false)),
        ] {
            let mut invalid = actor.clone();
            invalid[key] = value;
            assert_eq!(
                bootstrap_receipt(&server, invalid).unwrap_err().code,
                "FIXTURE_BOOTSTRAP_INVALID"
            );
        }
        server.shutdown().unwrap();
        Server::finish(server).unwrap();
    }
}
