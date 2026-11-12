//! Which data directory this owner may serve: one inside an isolated copy folder (`MILAGRE-ISOLATED-COPY`), never a
//! live profile.
//!
//! The folder is opened with [`Isolation::open`], which refuses Milagre's own folders, every Project and Link the
//! installed Milagre registered, and a copy where any Project holds an owner lock. [`owner_policy`] adds the same
//! folders under the account's own home directory (from the password database) to the `$HOME`-based ones, so a
//! `HOME` pointed elsewhere never hides the real profile.
use milagre_owner_store::{isolation::MARKER, jsjson, Isolation, Policy};
use serde_json::Value;
use std::{
    ffi::CStr,
    path::{Path, PathBuf},
};

/// The data folders Milagre uses under one home directory (`rust-owner` audit's list) and `~/.milagre`.
fn milagre_folders(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Library/Application Support/Milagre"),
        home.join(".config/Milagre"),
        home.join(".milagre/data"),
        home.join(".milagre"),
    ]
}

/// The account's home directory from the password database, whatever `HOME` says.
fn account_home() -> Option<PathBuf> {
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer refers to memory owned here and sized as passed.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || entry.pw_dir.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_dir points at a NUL-terminated string inside `buffer`.
    let dir = unsafe { CStr::from_ptr(entry.pw_dir) };
    Some(PathBuf::from(dir.to_string_lossy().into_owned()))
}

/// Every absolute `path`-like string in a registry file, read-only; nothing when it can't be read.
fn registry_paths(file: &Path) -> Vec<PathBuf> {
    fn walk(value: &Value, out: &mut Vec<PathBuf>) {
        match value {
            Value::Object(map) => {
                for (key, item) in map {
                    match (key.as_str(), item) {
                        ("path" | "worktreePath" | "projectPath", Value::String(path))
                            if path.starts_with('/') =>
                        {
                            out.push(PathBuf::from(path))
                        }
                        _ => walk(item, out),
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Some(value) = std::fs::read(file)
        .ok()
        .and_then(|bytes| jsjson::parse_bytes(&bytes).ok())
    {
        walk(&value, &mut out);
    }
    out
}

/// [`Policy::system`] plus the account home's Milagre folders and the Projects their registries list.
pub fn owner_policy() -> Policy {
    let mut policy = Policy::system();
    if let Some(home) = account_home() {
        for folder in milagre_folders(&home) {
            for name in ["project-registry.json", "recent-projects.json"] {
                policy.registered.extend(registry_paths(&folder.join(name)));
            }
            if !policy.protected.contains(&folder) {
                policy.protected.push(folder);
            }
        }
    }
    policy
}

/// The isolated copy folder holding `data_dir`: its nearest ancestor (never itself) with the marker file, opened with
/// `policy`'s checks. `data_dir` must be canonical.
pub fn isolation_for(data_dir: &Path, policy: &Policy) -> Result<Isolation, String> {
    let mut current = data_dir.parent();
    while let Some(folder) = current {
        match std::fs::symlink_metadata(folder.join(MARKER)) {
            Ok(meta) if meta.is_file() => {
                return Isolation::open(folder, policy).map_err(|error| error.to_string())
            }
            _ => current = folder.parent(),
        }
    }
    Err(format!(
        "{} isn't inside an isolated copy folder (one holding {MARKER}). The Rust profile owner serves only isolated data directories.",
        data_dir.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_home_is_protected_whatever_home_says() {
        let policy = owner_policy();
        let home = account_home().expect("this account has a home directory");
        assert!(policy
            .protected
            .contains(&home.join("Library/Application Support/Milagre")));
        assert!(policy.protected.contains(&home.join(".milagre")));
    }

    #[test]
    fn a_data_dir_outside_any_isolation_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let data = std::fs::canonicalize(base.path()).unwrap().join("profile");
        std::fs::create_dir(&data).unwrap();
        let error = isolation_for(&data, &Policy::default()).unwrap_err();
        assert!(error.contains("isolated copy folder"), "{error}");
    }

    #[test]
    fn the_real_profile_and_milagre_home_are_refused() {
        let home = account_home().unwrap();
        let policy = owner_policy();
        // No marker above the real profile: it is never an isolated copy.
        let profile = home.join("Library/Application Support/Milagre");
        assert!(isolation_for(&profile, &policy).is_err());
        // An isolated copy can't be made inside, or around, Milagre's own folders: the policy refuses before anything is
        // created.
        for live in [
            home.join(".milagre/profile-owner-policy-test"),
            profile.join("profile-owner-policy-test"),
        ] {
            let error = Isolation::create(&live, &policy).unwrap_err().to_string();
            if live.parent().is_some_and(Path::exists) {
                assert!(error.contains("overlaps"), "{live:?}: {error}");
            }
            assert!(!live.exists());
        }
    }
}
