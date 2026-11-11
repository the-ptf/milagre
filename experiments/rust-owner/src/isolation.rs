//! Where the Rust owner is allowed to write: an explicitly marked, isolated folder of copies, never a live profile or
//! Project.
//!
//! An [`Isolation`] is a folder holding the marker file [`MARKER`], made by [`Isolation::create`] in an empty or new
//! folder. Creating or opening one is refused when the folder:
//!
//! - is inside, or contains, a Milagre data folder (`~/Library/Application Support/Milagre`, `~/.config/Milagre`,
//!   `$MILAGRE_DATA_DIR`) or `~/.milagre` (Worktrees, the chats home, routines);
//! - is inside, or contains, a Project or Link that Milagre has registered or opened (`project-registry.json`,
//!   `recent-projects.json` of those data folders);
//! - holds any Project with an owner lock (`.milagre/runtime.lock`), live or not, when it is opened for writing.
//!
//! Nothing here ever writes outside the folder, and the checks only read Milagre's files.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{Result, StoreError};

/// The marker file that makes a folder an isolated copy.
pub const MARKER: &str = "MILAGRE-ISOLATED-COPY";

const MARKER_TEXT: &str = "This folder holds copies of Milagre Projects for the Rust owner experiment (experiments/rust-owner).\nThe Rust owner writes only inside folders with this file. Delete the folder when you are done.\n";

/// The folders an isolated copy must stay clear of.
#[derive(Clone, Debug, Default)]
pub struct Policy {
    /// Milagre's own folders: nothing inside them, or containing them, can be isolated.
    pub protected: Vec<PathBuf>,
    /// Projects and Links Milagre knows: same rule.
    pub registered: Vec<PathBuf>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn data_dirs() -> Vec<PathBuf> {
    let mut dirs = crate::audit::default_data_dirs();
    if let Some(custom) = std::env::var_os("MILAGRE_DATA_DIR") {
        dirs.push(PathBuf::from(custom));
    }
    dirs
}

/// Every `path` string in a registry file (projects, links, worktrees), read-only; nothing when it can't be read.
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
        .and_then(|bytes| crate::jsjson::parse_bytes(&bytes).ok())
    {
        walk(&value, &mut out);
    }
    out
}

impl Policy {
    /// This computer's Milagre folders and registered Projects.
    pub fn system() -> Self {
        let mut protected = data_dirs();
        if let Some(home) = home() {
            protected.push(home.join(".milagre"));
        }
        let registered = data_dirs()
            .iter()
            .flat_map(|dir| {
                ["project-registry.json", "recent-projects.json"].map(|name| dir.join(name))
            })
            .flat_map(|file| registry_paths(&file))
            .collect();
        Policy {
            protected,
            registered,
        }
    }

    fn check(&self, root: &Path) -> Result<()> {
        let canonical =
            |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        for (kind, paths) in [
            ("Milagre's own folder", &self.protected),
            ("a Project Milagre knows", &self.registered),
        ] {
            for path in paths {
                let path = canonical(path);
                if root.starts_with(&path) || path.starts_with(root) {
                    return Err(StoreError::NotIsolated(format!(
                        "{} overlaps {kind} ({}). Copy the Projects into a new folder elsewhere.",
                        root.display(),
                        path.display()
                    )));
                }
            }
        }
        Ok(())
    }
}

/// An isolated folder of Project copies the Rust owner may write in.
#[derive(Clone, Debug)]
pub struct Isolation {
    root: PathBuf,
}

impl Isolation {
    /// Marks `dir` (new, or empty) as an isolated copy folder.
    pub fn create(dir: &Path, policy: &Policy) -> Result<Self> {
        if dir.exists() {
            let mut entries =
                std::fs::read_dir(dir).map_err(|error| StoreError::io(error, "scandir", dir))?;
            if entries.next().is_some() {
                return Err(StoreError::NotIsolated(format!(
                    "{} isn't empty. An isolated copy starts in a new or empty folder.",
                    dir.display()
                )));
            }
        }
        // Checked before anything is created, on the path as it will resolve.
        let parent = dir.parent().unwrap_or(Path::new("/"));
        let resolved = std::fs::canonicalize(parent)
            .map_err(|error| StoreError::io(error, "realpath", parent))?
            .join(
                dir.file_name()
                    .ok_or_else(|| StoreError::NotIsolated("Name a folder.".into()))?,
            );
        policy.check(&resolved)?;
        std::fs::create_dir_all(dir).map_err(|error| StoreError::io(error, "mkdir", dir))?;
        let root =
            std::fs::canonicalize(dir).map_err(|error| StoreError::io(error, "realpath", dir))?;
        policy.check(&root)?;
        let marker = root.join(MARKER);
        std::fs::write(&marker, MARKER_TEXT)
            .map_err(|error| StoreError::io(error, "open", &marker))?;
        Ok(Isolation { root })
    }

    /// An existing isolated copy folder, checked again, with no owner lock in any of its Projects.
    pub fn open(dir: &Path, policy: &Policy) -> Result<Self> {
        let root =
            std::fs::canonicalize(dir).map_err(|error| StoreError::io(error, "realpath", dir))?;
        if !root.join(MARKER).is_file() {
            return Err(StoreError::NotIsolated(format!(
                "{} has no {MARKER} file. The Rust owner writes only in folders made with `milagre-owner-store prepare-copy` (or Isolation::create).",
                root.display()
            )));
        }
        policy.check(&root)?;
        if let Some(project) = folders_with_locks(&root).into_iter().next() {
            let lock = crate::ownership::project_lock(&project);
            let state = crate::ownership::inspect(&lock, &crate::ownership::SystemProbe);
            return Err(StoreError::NotIsolated(format!(
                "{} has an owner lock ({}). Copy the Project without .milagre/runtime.lock, or remove the lock after checking its owner is gone.",
                project.display(),
                state.label()
            )));
        }
        Ok(Isolation { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A Project folder inside this copy (made if missing), resolved.
    pub fn project(&self, path: &Path) -> Result<PathBuf> {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        std::fs::create_dir_all(&path).map_err(|error| StoreError::io(error, "mkdir", &path))?;
        let resolved = std::fs::canonicalize(&path)
            .map_err(|error| StoreError::io(error, "realpath", &path))?;
        if !resolved.starts_with(&self.root) {
            return Err(StoreError::NotIsolated(format!(
                "{} is outside the isolated copy {}.",
                resolved.display(),
                self.root.display()
            )));
        }
        Ok(resolved)
    }

    /// Copies a Project's saved state (`.milagre/` without its lock, runtime folder or temporary files) into
    /// `name`. The source is only read, with plain file reads: no SQLite lock, nothing a running owner would notice.
    /// A source mid-transaction (a hot journal or WAL beside chats.db) is refused: copy again when it is idle.
    pub fn copy_project(&self, source: &Path, name: &str) -> Result<PathBuf> {
        let from = source.join(".milagre");
        for side in ["chats.db-journal", "chats.db-wal"] {
            if std::fs::metadata(from.join(side))
                .map(|meta| meta.len() > 0)
                .unwrap_or(false)
            {
                return Err(StoreError::HotJournal(from.join("chats.db")));
            }
        }
        let target = self.project(Path::new(name))?;
        let to = target.join(".milagre");
        if to.exists() {
            return Err(StoreError::NotIsolated(format!(
                "{} already holds a Project.",
                target.display()
            )));
        }
        copy_tree(&from, &to)?;
        Ok(target)
    }
}

/// Every folder under `root` (itself included, five levels down) whose `.milagre/runtime.lock` exists, Project state
/// or not: a runtime that just took a lock may not have written anything yet.
fn folders_with_locks(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if crate::ownership::project_lock(&dir).exists() {
            found.push(dir.clone());
        }
        if depth >= 5 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if matches!(
                name.to_string_lossy().as_ref(),
                ".milagre" | ".git" | "node_modules"
            ) {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    found
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|error| StoreError::io(error, "mkdir", to))?;
    for entry in std::fs::read_dir(from).map_err(|error| StoreError::io(error, "scandir", from))? {
        let entry = entry.map_err(|error| StoreError::io(error, "scandir", from))?;
        let name = entry.file_name();
        let text = name.to_string_lossy();
        if matches!(
            text.as_ref(),
            "runtime.lock" | "runtime" | "runtime.lock.takeover"
        ) || text.ends_with(".tmp")
        {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|error| StoreError::io(error, "lstat", &entry.path()))?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(&name)).map_err(|error| {
                StoreError::io2(error, "copyfile", &entry.path(), &to.join(&name))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_milagre_folders_and_registered_projects() {
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("Milagre");
        let project = base.path().join("code/app");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        std::fs::write(
            data.join("project-registry.json"),
            format!(
                r#"{{"projects":[{{"id":"x","path":"{}"}}]}}"#,
                project.display()
            ),
        )
        .unwrap();
        let policy = Policy {
            protected: vec![data.clone()],
            registered: registry_paths(&data.join("project-registry.json")),
        };
        assert_eq!(policy.registered.len(), 1);
        for denied in [
            data.join("copies"),
            project.join("copies"),
            base.path().join("code"),
        ] {
            assert!(Isolation::create(&denied, &policy).is_err(), "{denied:?}");
            assert!(!denied.join(MARKER).exists());
            let resolved = std::fs::canonicalize(denied.parent().unwrap())
                .unwrap()
                .join(denied.file_name().unwrap());
            let error = policy.check(&resolved).unwrap_err().to_string();
            assert!(error.contains("overlaps"), "{denied:?}: {error}");
        }
        let ok = Isolation::create(&base.path().join("copies"), &policy).unwrap();
        assert!(ok.root().join(MARKER).is_file());
        // Not empty any more: can't be created again, can be opened.
        assert!(Isolation::create(&base.path().join("copies"), &policy).is_err());
        Isolation::open(&base.path().join("copies"), &policy).unwrap();
        // A folder without the marker is never written.
        std::fs::create_dir_all(base.path().join("plain")).unwrap();
        assert!(Isolation::open(&base.path().join("plain"), &policy)
            .unwrap_err()
            .to_string()
            .contains(MARKER));
        // Outside paths are refused.
        assert!(ok.project(&base.path().join("elsewhere")).is_err());
    }

    #[test]
    fn refuses_a_copy_with_an_owner_lock() {
        let base = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre/runtime.lock")).unwrap();
        std::fs::write(project.join(".milagre/coordination.json"), "{}").unwrap();
        let error = Isolation::open(isolation.root(), &Policy::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("owner lock"), "{error}");
    }

    #[test]
    fn system_policy_covers_this_computers_milagre() {
        let policy = Policy::system();
        if let Some(home) = home() {
            assert!(policy.protected.contains(&home.join(".milagre")));
            assert!(policy.check(&home.join(".milagre/worktrees/x")).is_err());
            assert!(policy
                .check(&home.join("Library/Application Support/Milagre/x"))
                .is_err());
        }
    }
}
