use super::*;
use std::{os::unix::fs::symlink, time::Duration};
fn source() -> tempfile::TempDir {
    let dir = tempfile::Builder::new().prefix("milagre-acp-copy-source-").tempdir_in("/tmp").unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut bytes = vec![0; 70_000];
    bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
    fs::write(dir.path().join(BINARY), bytes).unwrap();
    fs::set_permissions(dir.path().join(BINARY), fs::Permissions::from_mode(0o700)).unwrap();
    dir
}
fn until() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn prepare(dir: &tempfile::TempDir) -> Prepared {
    Prepared::copy(fs::canonicalize(dir.path()).unwrap(), until(), |_, _| {}).unwrap()
}
fn restore_cleanup(prepared: &mut Prepared) {
    // Only the synthetic test owns these paths. Restore identities after its tamper
    // so the test removes its resources; production never refreshes a rejected pin.
    prepared.storage.root.identity = Identity::of(&prepared.storage.root.file.metadata().unwrap());
    for entry in &mut prepared.storage.entries {
        entry.identity = Identity::of(&entry.file.metadata().unwrap());
    }
    assert!(prepared.storage.cleanup());
}
#[test]
fn bounded_copy_matches_both_pins_and_closes_writable_descriptors() {
    let source = source();
    let mut prepared = prepare(&source);
    assert_eq!(fs::metadata(prepared.executable()).unwrap().permissions().mode() & 0o777, 0o500);
    assert_eq!(prepared.storage.root.file.metadata().unwrap().mode() & 0o777, 0o700);
    let copied = &prepared.storage.entries[prepared.executable].file;
    assert_eq!(unsafe { libc::fcntl(copied.as_raw_fd(), libc::F_GETFL) } & libc::O_ACCMODE, libc::O_RDONLY);
    assert_eq!(hash(&mut prepared.source.file, until()).unwrap(), prepared.digest);
    prepared.check(until()).unwrap();
    assert!(prepared.storage.cleanup());
}
#[test]
fn source_path_swap_and_mutation_during_copy_are_refused() {
    for swap in [false, true] {
        let source = source();
        let mut changed = false;
        let result = Prepared::copy(fs::canonicalize(source.path()).unwrap(), until(), |prepared, stage| {
            if changed || stage != CopyStage::Chunk {
                return;
            }
            changed = true;
            if swap {
                let path = &prepared.source.path;
                fs::rename(path, path.with_extension("original")).unwrap();
                fs::write(path, b"replacement").unwrap();
            } else {
                OpenOptions::new().write(true).open(&prepared.source.path).unwrap().set_len(512).unwrap();
            }
        });
        assert!(matches!(result, Err(Error::Identity | Error::Artifact)));
    }
}
#[test]
fn scripts_empty_and_one_over_artifact_limit_are_refused() {
    for length in [0, ARTIFACT_LIMIT + 1, 3] {
        let source = source();
        let mut file = OpenOptions::new().write(true).open(source.path().join(BINARY)).unwrap();
        file.set_len(length).unwrap();
        if length == 3 {
            file.write_all(b"#!/").unwrap();
        }
        assert!(matches!(Prepared::copy(fs::canonicalize(source.path()).unwrap(), until(), |_, _| {}), Err(Error::Artifact)));
    }
}
#[test]
fn private_executable_path_mode_bytes_and_parent_changes_are_refused() {
    for mutation in 0..6 {
        let source = source();
        let mut prepared = prepare(&source);
        let root = prepared.storage.root.path.clone();
        let exe = prepared.executable().to_owned();
        match mutation {
            0 => {
                fs::rename(&exe, root.join("held-exe")).unwrap();
                symlink(source.path().join(BINARY), &exe).unwrap();
            }
            1 => {
                fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
            }
            2 => {
                fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
                let mut file = OpenOptions::new().write(true).open(&exe).unwrap();
                file.write_all(b"oops").unwrap();
                file.set_permissions(fs::Permissions::from_mode(0o500)).unwrap();
            }
            3 => {
                fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
            }
            4 | 5 => {
                fs::rename(&root, root.with_extension("held")).unwrap();
                if mutation == 4 {
                    symlink(source.path(), &root).unwrap();
                } else {
                    fs::create_dir(&root).unwrap();
                }
            }
            _ => unreachable!(),
        }
        assert!(prepared.check(until()).is_err());
        assert!(!prepared.storage.cleanup());
        match mutation {
            0 => {
                fs::remove_file(&exe).unwrap();
                fs::rename(root.join("held-exe"), &exe).unwrap();
            }
            1 => fs::set_permissions(&exe, fs::Permissions::from_mode(0o500)).unwrap(),
            2 => {}
            3 => fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap(),
            4 | 5 => {
                if mutation == 4 {
                    fs::remove_file(&root).unwrap();
                } else {
                    fs::remove_dir(&root).unwrap();
                }
                fs::rename(root.with_extension("held"), &root).unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(fs::metadata(source.path().join(BINARY)).unwrap().len(), 70_000);
        restore_cleanup(&mut prepared);
    }
}
#[test]
fn workspace_path_replacement_refuses_and_retains_original_directory_descriptor() {
    let source = source();
    let mut prepared = prepare(&source);
    let root = prepared.storage.root.path.clone();
    let original = prepared.cwd().dev_ino();
    fs::rename(root.join("workspace"), root.join("held-workspace")).unwrap();
    fs::create_dir(root.join("workspace")).unwrap();
    assert!(prepared.check(until()).is_err());
    let held = prepared.cwd().file.metadata().unwrap();
    assert_eq!((held.dev(), held.ino()), original);
    let replacement = fs::metadata(root.join("workspace")).unwrap();
    assert_ne!((replacement.dev(), replacement.ino()), original);
    fs::remove_dir(root.join("workspace")).unwrap();
    fs::rename(root.join("held-workspace"), root.join("workspace")).unwrap();
    restore_cleanup(&mut prepared);
}

#[test]
fn preparation_failure_keeps_the_partial_storage_owned_and_refuses_cleanup_of_replacement() {
    let source = source();
    let mut prepared = Prepared::from_parent(fs::canonicalize(source.path()).unwrap()).unwrap();
    let root = prepared.storage.root.path.clone();
    let result = prepared.populate_with(until(), |pins, stage| {
        if stage == CopyStage::WritableClosed {
            let exe = pins.storage.root.path.join(BINARY);
            fs::rename(&exe, pins.storage.root.path.join("held-original")).unwrap();
            fs::write(&exe, b"replacement").unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o500)).unwrap();
        }
    });
    assert_eq!(result, Err(Error::Identity));
    assert!(root.exists());
    assert!(!prepared.storage.cleanup());
    assert_eq!(fs::read(root.join(BINARY)).unwrap(), b"replacement");
    // The synthetic test owns both files and explicitly removes them after proving
    // production cleanup refused. No production code adopts the replacement pin.
    fs::remove_file(root.join(BINARY)).unwrap();
    fs::remove_file(root.join("held-original")).unwrap();
    assert!(prepared.storage.cleanup());
}
