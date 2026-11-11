//! An open Project's root stays the folder that was opened. Its key is worked out from the path alone (no walk per
//! event), so every write checks the root instead: the same device and inode, and a canonical path that is still its
//! own (no link on it or above it). A Project moved away with its lock and replaced by a link, or a link put above the
//! root, must fail the next write and write nothing anywhere.

use std::collections::BTreeMap;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::states::{ProjectStates, Timing};
use milagre_owner_store::StoreError;
use serde_json::json;

/// Every file under `dir` with its bytes (links not followed).
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.is_dir() {
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
