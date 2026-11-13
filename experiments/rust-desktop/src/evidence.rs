//! Private diagnostic output, with no symlink following or permissive existing files.
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{fs, io::Write, path::Path};

pub fn write(path: impl AsRef<Path>, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err("Diagnostic destination must be an owned regular file with one link".into());
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    file.set_len(0).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_paths_cannot_follow_links_or_leave_public_content() {
        let root = std::env::temp_dir().join(format!("rust-evidence-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let original = root.join("original");
        fs::write(&original, "private original").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(write(&link, b"replacement").is_err());
        let hardlink = root.join("hardlink");
        fs::hard_link(&original, &hardlink).unwrap();
        assert!(write(&hardlink, b"replacement").is_err());
        assert_eq!(fs::read(&original).unwrap(), b"private original");
        fs::remove_file(hardlink).unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o644)).unwrap();
        write(&original, b"new").unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"new");
        assert_eq!(fs::metadata(&original).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(root).unwrap();
    }
}
