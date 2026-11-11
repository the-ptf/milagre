//! Containment before mutation: nothing outside an isolated copy is created, locked or written, whatever path or
//! link a caller or a copied Project brings. Every test works in a fresh temporary folder holding the isolation and an
//! external sentinel folder, and checks the sentinel is byte-for-byte as it was.

use std::collections::BTreeMap;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::write::ProjectStateWriter;
use milagre_owner_store::OwnedProject;

type Make = Box<dyn Fn(&Path)>;

struct Setup {
    _base: tempfile::TempDir,
    isolation: Isolation,
    outside: PathBuf,
}

fn setup() -> Setup {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("isolated"), &Policy::default()).unwrap();
    let outside = std::fs::canonicalize(base.path()).unwrap().join("sentinel");
    std::fs::create_dir_all(outside.join("meta")).unwrap();
    std::fs::write(outside.join("file.db"), b"sentinel database").unwrap();
    std::fs::write(
        outside.join("meta/coordination.json"),
        b"{\"sentinel\":true}",
    )
    .unwrap();
    Setup {
        _base: base,
        isolation,
        outside,
    }
}

/// Every path under `dir` with its bytes (folders as empty), following nothing.
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.is_dir() {
            out.insert(path.clone(), Vec::new());
            for entry in std::fs::read_dir(&path).unwrap() {
                stack.push(entry.unwrap().path());
            }
        } else {
            out.insert(path.clone(), std::fs::read(&path).unwrap_or_default());
        }
    }
    out
}

fn assert_refused<T: std::fmt::Debug>(
    result: milagre_owner_store::Result<T>,
    what: &str,
) -> String {
    match result {
        Ok(value) => panic!("{what}: accepted ({value:?})"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn paths_outside_are_refused_before_anything_is_created() {
    let s = setup();
    let before = tree(&s.outside);
    let parent = s.outside.parent().unwrap().to_path_buf();
    let attempts: Vec<PathBuf> = vec![
        PathBuf::from("../sentinel/created"),
        PathBuf::from("a/../../sentinel/created"),
        PathBuf::from("../../escape"),
        s.outside.join("created"),
        parent.join("created-next-to-isolation"),
        PathBuf::from("/"),
        PathBuf::from(""),
        PathBuf::from("."),
        PathBuf::from("a/.."),
        s.isolation.root().to_path_buf(),
    ];
    for attempt in &attempts {
        let error = assert_refused(s.isolation.project(attempt), &attempt.display().to_string());
        assert!(error.contains("isolated copy"), "{attempt:?}: {error}");
        assert!(assert_refused(
            OwnedProject::open(&s.isolation, attempt).map(|_| ()),
            "open"
        )
        .contains("isolated copy"));
    }
    assert_eq!(tree(&s.outside), before, "the sentinel changed");
    assert!(
        !s.outside.join("created").exists()
            && !parent.join("created-next-to-isolation").exists()
            && !parent.join("escape").exists()
    );
    // Nothing was made inside the isolation for the refused attempts either (`a` included).
    assert!(!s.isolation.root().join("a").exists());
}

#[test]
fn symlinks_along_the_project_path_are_refused() {
    let s = setup();
    let before = tree(&s.outside);
    symlink(&s.outside, s.isolation.root().join("link")).unwrap();
    std::fs::create_dir_all(s.isolation.root().join("real")).unwrap();
    std::fs::write(s.isolation.root().join("real/file"), b"x").unwrap();
    for attempt in ["link", "link/project", "link/meta", "real/file/project"] {
        let error = assert_refused(s.isolation.project(Path::new(attempt)), attempt);
        assert!(
            error.contains("symbolic link") || error.contains("goes through a file"),
            "{attempt}: {error}"
        );
        assert!(OwnedProject::open(&s.isolation, Path::new(attempt)).is_err());
    }
    assert_eq!(tree(&s.outside), before);
    assert!(!s.outside.join("project").exists());
}

#[test]
fn links_inside_milagre_are_refused_before_the_lock() {
    let s = setup();
    let before = tree(&s.outside);
    let cases: Vec<(&str, Make)> = vec![
        (
            ".milagre is a link",
            Box::new(|project: &Path| {
                symlink(
                    project.join("../../sentinel/meta"),
                    project.join(".milagre"),
                )
                .unwrap()
            }),
        ),
        ("chats.db is a link", {
            let outside = s.outside.clone();
            Box::new(move |project: &Path| {
                std::fs::create_dir_all(project.join(".milagre")).unwrap();
                symlink(outside.join("file.db"), project.join(".milagre/chats.db")).unwrap();
            })
        }),
        ("details is a link", {
            let outside = s.outside.clone();
            Box::new(move |project: &Path| {
                std::fs::create_dir_all(project.join(".milagre")).unwrap();
                symlink(outside.join("meta"), project.join(".milagre/details")).unwrap();
            })
        }),
        ("runtime.lock is a link", {
            let outside = s.outside.clone();
            Box::new(move |project: &Path| {
                std::fs::create_dir_all(project.join(".milagre")).unwrap();
                symlink(outside.join("meta"), project.join(".milagre/runtime.lock")).unwrap();
            })
        }),
        ("coordination.json is hard-linked outside", {
            let outside = s.outside.clone();
            Box::new(move |project: &Path| {
                std::fs::create_dir_all(project.join(".milagre")).unwrap();
                std::fs::hard_link(
                    outside.join("meta/coordination.json"),
                    project.join(".milagre/coordination.json"),
                )
                .unwrap();
            })
        }),
        ("a sidecar is a link", {
            let outside = s.outside.clone();
            Box::new(move |project: &Path| {
                std::fs::create_dir_all(project.join(".milagre/subagents")).unwrap();
                symlink(
                    outside.join("file.db"),
                    project.join(".milagre/subagents/0000.json"),
                )
                .unwrap();
            })
        }),
    ];
    for (index, (label, make)) in cases.iter().enumerate() {
        let name = format!("p{index}");
        let project = s.isolation.root().join(&name);
        std::fs::create_dir_all(&project).unwrap();
        make(&project);
        let error = assert_refused(
            OwnedProject::open(&s.isolation, Path::new(&name)).map(|_| ()),
            label,
        );
        assert!(error.contains("doesn't follow it"), "{label}: {error}");
        // No lock was taken: not inside the Project, not wherever its links point.
        assert!(
            std::fs::symlink_metadata(project.join(".milagre/runtime.lock"))
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(true),
            "{label}: lock taken"
        );
        assert!(
            !s.outside.join("meta/owner.json").exists()
                && !s.outside.join("meta/runtime.lock").exists(),
            "{label}: lock written outside"
        );
        assert_eq!(tree(&s.outside), before, "{label}: the sentinel changed");
    }
}

#[test]
fn an_isolation_root_given_as_a_link_is_refused() {
    let base = tempfile::tempdir().unwrap();
    let target = base.path().join("target");
    std::fs::create_dir(&target).unwrap();
    symlink(&target, base.path().join("alias")).unwrap();
    assert!(Isolation::create(&base.path().join("alias"), &Policy::default()).is_err());
    assert!(
        std::fs::read_dir(&target).unwrap().next().is_none(),
        "no marker written through the link"
    );
    Isolation::create(&target, &Policy::default()).unwrap();
    assert!(Isolation::open(&base.path().join("alias"), &Policy::default()).is_err());
}

#[test]
fn a_clean_project_still_works() {
    let s = setup();
    let mut owner = OwnedProject::open(&s.isolation, Path::new("nested/project")).unwrap();
    owner
        .save_project_state(
            &serde_json::json!({ "sessions": {}, "messages": [] }),
            &Default::default(),
        )
        .unwrap();
    owner.release().unwrap();
    assert!(s
        .isolation
        .root()
        .join("nested/project/.milagre/chats.db")
        .is_file());
    // A second open re-checks what the first one wrote (no links, single links): accepted.
    OwnedProject::open(&s.isolation, Path::new("nested/project"))
        .unwrap()
        .release()
        .unwrap();
}
