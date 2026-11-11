//! An open Project's root stays the folder that was opened. Its key is worked out from the path alone (no walk per
//! event), so every write checks the root instead: the same device and inode, and a canonical path that is still its
//! own (no link on it or above it). A Project moved away with its lock and replaced by a link, or a link put above the
//! root, must fail the next write and write nothing anywhere.

use std::collections::BTreeMap;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::owner::OwnedProject;
use milagre_owner_store::ownership::{test_hooks, RustOwnerLock};
use milagre_owner_store::states::{ProjectStates, Timing};
use milagre_owner_store::write::OwnerLock;
use milagre_owner_store::StoreError;
use serde_json::json;

/// Every folder and file under `dir`, files with their bytes (links not followed), so an emptied or removed lock
/// folder shows too.
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.is_dir() {
            out.insert(path.strip_prefix(dir).unwrap().join("<folder>"), Vec::new());
            for entry in std::fs::read_dir(&path).unwrap() {
                stack.push(entry.unwrap().path());
            }
        } else if meta.is_file() {
            out.insert(
                path.strip_prefix(dir).unwrap().to_path_buf(),
                std::fs::read(&path).unwrap(),
            );
        }
    }
    out
}

struct Open {
    base: tempfile::TempDir,
    states: ProjectStates,
    project: PathBuf,
}

/// An isolated copy at `<base>/copies` with Project `p`, opened, changed and saved once.
fn open() -> Open {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    std::fs::write(
        project.join(".milagre/coordination.json"),
        r#"{"next_id":1,"sessions":{"1":{"id":1}},"messages":[]}"#,
    )
    .unwrap();
    let mut states = ProjectStates::new(isolation, Timing::default(), 0);
    states.get(&project).unwrap();
    change(&mut states, &project, "first").unwrap();
    states.flush(Some(&project)).unwrap();
    Open {
        base,
        states,
        project,
    }
}

fn change(
    states: &mut ProjectStates,
    project: &Path,
    title: &str,
) -> milagre_owner_store::Result<()> {
    states.update(project, Some(&[]), true, |state| {
        let mut sessions = state.sessions().cloned().unwrap_or_default();
        sessions.insert("1".into(), json!({ "id": 1, "title": title }));
        Some(state.with_field("sessions", serde_json::Value::Object(sessions)))
    })?;
    states.flush(Some(project))
}

/// Copies `from` to `to` (folders and files), as a replacement folder holding the same lock record would be.
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn lock_record(project: &Path) -> PathBuf {
    project.join(".milagre/runtime.lock/owner.json")
}

fn refused(result: milagre_owner_store::Result<()>) {
    match result {
        Err(StoreError::OwnershipLost { why, .. }) => {
            assert!(why.contains("Project folder"), "{why}");
        }
        other => panic!("a write through a replaced root went on: {other:?}"),
    }
}

#[test]
fn a_project_moved_away_and_replaced_by_a_link_is_not_written() {
    let mut open = open();
    let elsewhere = open.base.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let moved = elsewhere.join("p");
    std::fs::rename(&open.project, &moved).unwrap();
    symlink(&moved, &open.project).unwrap();
    let before = tree(&moved);
    // The lock moved with the folder (same token, same pid): only the root check can tell.
    refused(change(&mut open.states, &open.project, "second"));
    refused(open.states.assert_owned(&open.project));
    assert_eq!(
        tree(&moved),
        before,
        "a write landed outside the isolated copy"
    );
}

#[test]
fn a_link_above_the_root_is_not_written_through() {
    let mut open = open();
    let copies = open.base.path().join("copies");
    let moved = open.base.path().join("moved");
    std::fs::rename(&copies, &moved).unwrap();
    symlink(&moved, &copies).unwrap();
    let before = tree(&moved);
    refused(change(&mut open.states, &open.project, "second"));
    assert_eq!(
        tree(&moved),
        before,
        "a write went through a link above the root"
    );
}

#[test]
fn an_unchanged_root_keeps_writing() {
    let mut open = open();
    change(&mut open.states, &open.project, "second").unwrap();
    open.states.assert_owned(&open.project).unwrap();
    let saved = std::fs::read_to_string(open.project.join(".milagre/coordination.json")).unwrap();
    assert!(saved.contains("second"), "{saved}");
}

/// Moves the Project to `<base>/elsewhere/p` (its lock with it) and puts a link at the old path.
fn swap_for_link(open: &Open) -> PathBuf {
    let elsewhere = open.base.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let moved = elsewhere.join("p");
    std::fs::rename(&open.project, &moved).unwrap();
    symlink(&moved, &open.project).unwrap();
    moved
}

/// Closing after the swap refuses to release (the lock path leads into the moved folder), and dropping the states
/// afterwards removes nothing there either: the lock record and its folder stay byte for byte.
#[test]
fn closing_or_dropping_after_a_link_swap_removes_nothing() {
    let mut open = open();
    let moved = swap_for_link(&open);
    let before = tree(&moved);
    assert!(lock_record(&moved).exists());
    refused(open.states.close());
    drop(open.states);
    assert_eq!(
        tree(&moved),
        before,
        "the lock outside the copy was removed"
    );
}

/// The same with unsaved changes: the close fails at the save, keeps its locks, and the drop that follows must not
/// release them through the link.
#[test]
fn dropping_unsaved_states_after_a_link_swap_removes_nothing() {
    let mut open = open();
    let moved = swap_for_link(&open);
    refused(change(&mut open.states, &open.project, "second"));
    let before = tree(&moved);
    assert!(open.states.close().is_err());
    refused(open.states.forget(&open.project));
    drop(open.states);
    assert_eq!(
        tree(&moved),
        before,
        "the lock outside the copy was removed"
    );
}

/// `forget` and `abandon` release too; neither removes the moved lock. A refused forget still drops the Project from
/// memory (its lock stays for an operator), so nothing is left to release later.
#[test]
fn forgetting_or_abandoning_after_a_link_swap_removes_nothing() {
    let mut open = open();
    let moved = swap_for_link(&open);
    let before = tree(&moved);
    refused(open.states.forget(&open.project));
    assert!(!open.states.has(&open.project));
    drop(open.states);
    assert_eq!(
        tree(&moved),
        before,
        "forget removed the lock outside the copy"
    );

    let open = self::open();
    let moved = swap_for_link(&open);
    let before = tree(&moved);
    refused(open.states.abandon());
    assert_eq!(
        tree(&moved),
        before,
        "abandon removed the lock outside the copy"
    );
}

/// The root replaced by a different real folder at the same path (a new inode) holding a copy of everything, our lock
/// record included: writes are refused, and closing or dropping removes neither copy of the lock.
#[test]
fn a_real_folder_put_in_place_of_the_root_is_not_written_or_released() {
    let mut open = open();
    let elsewhere = open.base.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let moved = elsewhere.join("p");
    std::fs::rename(&open.project, &moved).unwrap();
    copy_tree(&moved, &open.project);
    assert_eq!(
        std::fs::read(lock_record(&open.project)).unwrap(),
        std::fs::read(lock_record(&moved)).unwrap(),
        "the replacement holds our lock record"
    );
    let (moved_before, replaced_before) = (tree(&moved), tree(&open.project));
    refused(change(&mut open.states, &open.project, "second"));
    refused(open.states.assert_owned(&open.project));
    assert!(open.states.close().is_err());
    drop(open.states);
    assert_eq!(tree(&moved), moved_before, "the moved Project was touched");
    assert_eq!(
        tree(&open.project),
        replaced_before,
        "the replacement folder was written or its lock released"
    );
}

/// An unchanged root still releases: close removes the lock record and its folder.
#[test]
fn an_unchanged_root_releases_on_close() {
    let mut open = open();
    open.states.close().unwrap();
    assert!(!open.project.join(".milagre/runtime.lock").exists());
}

/// Dropping the states after a refused release records the lock left behind (once), with why, never the token.
#[test]
fn a_lock_a_drop_could_not_release_is_recorded() {
    let mut open = open();
    let moved = swap_for_link(&open);
    refused(open.states.close());
    let stranded = open.states.take_stranded();
    assert_eq!(stranded.len(), 1, "{stranded:?}");
    assert!(stranded[0].why.contains("Project folder"), "{stranded:?}");
    assert!(open.states.take_stranded().is_empty(), "recorded once");
    assert!(lock_record(&moved).exists());
}

/// A lock is only taken inside a canonical root: a root spelled through a link, or a lock outside its root, is refused
/// before anything is made.
#[test]
fn a_lock_needs_a_canonical_root_that_holds_it() {
    let base = tempfile::tempdir().unwrap();
    let real = base.path().canonicalize().unwrap().join("real");
    std::fs::create_dir(&real).unwrap();
    let link = real.with_file_name("link");
    symlink(&real, &link).unwrap();
    let before = tree(&real);
    assert!(RustOwnerLock
        .acquire(&link, &link.join(".milagre/runtime.lock"))
        .is_err());
    assert!(RustOwnerLock
        .acquire(&real, &real.with_file_name("outside.lock"))
        .is_err());
    assert!(RustOwnerLock.acquire(&real, &real).is_err());
    assert_eq!(tree(&real), before);
    assert!(!real.with_file_name("outside.lock").exists());
}

/// The root swapped for a link after the lock is made but before it is pinned again: the open fails, the lock in the
/// moved folder is left for an operator (never removed through the link), and the folder behind the link stays as is.
#[test]
fn a_root_swapped_while_its_lock_is_taken_fails_closed() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let moved = base.path().canonicalize().unwrap().join("moved");
    let (from, to) = (project.clone(), moved.clone());
    test_hooks::after_lock_written(move || {
        std::fs::rename(&from, &to).unwrap();
        symlink(&to, &from).unwrap();
    });
    let error = match OwnedProject::open(&isolation, Path::new("p")) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("a lock taken across a swap was kept"),
    };
    assert!(
        error.contains("changed while its lock was taken"),
        "{error}"
    );
    assert!(
        lock_record(&moved).exists(),
        "the lock was removed through the swap"
    );
}

/// The same with a real folder put in place: the open fails and the replacement holds no lock.
#[test]
fn a_root_replaced_by_a_folder_while_its_lock_is_taken_fails_closed() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let moved = base.path().canonicalize().unwrap().join("moved");
    let (from, to) = (project.clone(), moved.clone());
    test_hooks::after_lock_written(move || {
        std::fs::rename(&from, &to).unwrap();
        std::fs::create_dir_all(from.join(".milagre")).unwrap();
    });
    assert!(OwnedProject::open(&isolation, Path::new("p")).is_err());
    assert!(lock_record(&moved).exists());
    assert!(!project.join(".milagre/runtime.lock").exists());
}
