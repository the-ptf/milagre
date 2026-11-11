//! Temporary-repository mutation capability. There is deliberately no constructor
//! from an existing folder and no raw Git command or RPC dispatcher.
mod commit;
mod worktrees;

use crate::{
    process::{isolated_process, IsolatedEnvironment, Outcome},
    GitError, READ_TIMEOUT,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;
pub use worktrees::{CreateWorktree, RemoveOptions, WorktreeStatus};

const WRITE_TIMEOUT: Duration = Duration::from_secs(300);
const MARKER: &str = ".milagre-isolated-git";
#[derive(Clone)]
pub struct IsolatedGit(Arc<Repository>);
struct Repository {
    directory: Option<TempDir>,
    root: PathBuf,
    project: PathBuf,
    common: PathBuf,
    environment: IsolatedEnvironment,
    nonce: String,
    identity: Identity,
    worktrees_identity: Identity,
    lane: AsyncMutex<State>,
    leases: Mutex<HashMap<PathBuf, usize>>,
    nul_listing: AtomicBool,
}
struct State {
    entries: HashMap<PathBuf, Entry>,
}
struct Entry {
    id: String,
    identity: Identity,
    base: Option<String>,
    removed: Option<Value>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
}
fn identity(path: &Path) -> Result<Identity, GitError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::getuid() }
    {
        return Err(scope("The isolated Git directory was replaced."));
    }
    Ok(Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
fn scope(message: impl Into<String>) -> GitError {
    GitError::validation("ISOLATED_GIT_SCOPE", message)
}
fn io_error(error: std::io::Error) -> GitError {
    GitError::validation("ISOLATED_GIT_IO", error.to_string())
}

/// An unforgeable in-process reference to a Worktree made by this capability.
/// Serialize `info()` for clients; retain the handle in the owner registry.
#[derive(Clone, Debug)]
pub struct OwnedWorktree {
    owner: String,
    id: String,
    path: PathBuf,
    branch: String,
    base: String,
}
impl OwnedWorktree {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn branch(&self) -> &str {
        &self.branch
    }
    pub fn base(&self) -> &str {
        &self.base
    }
    pub fn info(&self) -> Value {
        json!({"branch":self.branch,"path":self.path,"base":self.base})
    }
}
/// A provider/setup owner retains this lease until it has stopped using the folder.
/// Dropping the lease releases it and keeps the temporary repository alive until then.
pub struct WorktreeLease {
    repository: Arc<Repository>,
    path: PathBuf,
}
impl Drop for WorktreeLease {
    fn drop(&mut self) {
        let mut leases = self.repository.leases.lock().unwrap();
        if let Some(count) = leases.get_mut(&self.path) {
            *count -= 1;
            if *count == 0 {
                leases.remove(&self.path);
            }
        }
    }
}

impl Repository {
    fn verify_root(&self) -> Result<(), GitError> {
        if fs::canonicalize(&self.root).map_err(io_error)? != self.root
            || identity(&self.root)? != self.identity
            || fs::symlink_metadata(&self.root).map_err(io_error)?.mode() & 0o777 != 0o700
        {
            return Err(scope("The isolated Git root was replaced."));
        }
        let metadata = fs::symlink_metadata(self.root.join(MARKER)).map_err(io_error)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::getuid() }
            || metadata.mode() & 0o777 != 0o600
            || fs::read_to_string(self.root.join(MARKER)).map_err(io_error)? != self.nonce
        {
            return Err(scope("The isolated Git ownership marker changed."));
        }
        Ok(())
    }
}
impl Drop for Repository {
    fn drop(&mut self) {
        // A replaced root must never be recursively removed during teardown.
        if self.verify_root().is_err() {
            if let Some(directory) = self.directory.take() {
                let _ = directory.keep();
            }
        }
    }
}

impl IsolatedGit {
    /// Creates an empty `main` repository. No source repo, profile or existing path
    /// can be supplied. Fixture identity is local to this disposable repository.
    pub async fn create() -> Result<Self, GitError> {
        let directory = tempfile::Builder::new()
            .prefix("milagre-rust-git-write-")
            .tempdir_in(fs::canonicalize("/tmp").map_err(io_error)?)
            .map_err(io_error)?;
        let root = fs::canonicalize(directory.path()).map_err(io_error)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        let nonce = Uuid::new_v4().to_string();
        let mut marker = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join(MARKER))
            .map_err(io_error)?;
        marker.write_all(nonce.as_bytes()).map_err(io_error)?;
        marker.sync_all().map_err(io_error)?;
        let project = root.join("project");
        for folder in [
            &project,
            &root.join("worktrees"),
            &root.join("home"),
            &root.join("home/gnupg"),
        ] {
            fs::create_dir(folder).map_err(io_error)?;
            fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        }
        let common = project.join(".git");
        let mut entries = HashMap::new();
        entries.insert(
            project.clone(),
            Entry {
                id: "main".into(),
                identity: identity(&project)?,
                base: None,
                removed: None,
            },
        );
        let owner = Self(Arc::new(Repository {
            identity: identity(&root)?,
            worktrees_identity: identity(&root.join("worktrees"))?,
            directory: Some(directory),
            nonce,
            environment: IsolatedEnvironment {
                root: root.clone(),
                hooks: common.join("hooks"),
            },
            root,
            project,
            common,
            lane: AsyncMutex::new(State { entries }),
            leases: Mutex::new(HashMap::new()),
            nul_listing: AtomicBool::new(true),
        }));
        owner
            .checked(
                owner.project_path(),
                &["init", "--template=", "-b", "main"],
                None,
                WRITE_TIMEOUT,
            )
            .await?;
        for (key, value) in [
            ("user.name", "Milagre Rust Fixture"),
            ("user.email", "rust-fixture@milagre.invalid"),
            ("core.autocrlf", "false"),
            ("core.quotePath", "true"),
            ("commit.gpgSign", "false"),
        ] {
            owner
                .checked(
                    owner.project_path(),
                    &["config", "--local", key, value],
                    None,
                    WRITE_TIMEOUT,
                )
                .await?;
        }
        fs::create_dir_all(&owner.0.environment.hooks).map_err(io_error)?;
        Ok(owner)
    }
    pub fn root_path(&self) -> &Path {
        &self.0.root
    }
    pub fn project_path(&self) -> &Path {
        &self.0.project
    }
    pub fn worktree_root(&self) -> PathBuf {
        self.0.root.join("worktrees")
    }
    async fn run(
        &self,
        cwd: &Path,
        args: &[&str],
        input: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Outcome {
        isolated_process(cwd, args, input, &self.0.environment, timeout).await
    }
    async fn checked(
        &self,
        cwd: &Path,
        args: &[&str],
        input: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<String, GitError> {
        let result = self.run(cwd, args, input, timeout).await;
        if result.ok {
            Ok(result.stdout)
        } else {
            Err(result)
        }
    }
    async fn out(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let result = self.run(cwd, args, None, READ_TIMEOUT).await;
        result.ok.then(|| crate::trim(&result.stdout).into())
    }
    async fn commit_of(&self, cwd: &Path, reference: &str) -> Option<String> {
        if reference.contains('\0') {
            return None;
        }
        self.out(
            cwd,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("{reference}^{{commit}}"),
            ],
        )
        .await
        .filter(|s| !s.is_empty())
    }
    async fn validate(&self, cwd: &Path, state: &State) -> Result<PathBuf, GitError> {
        self.0.verify_root()?;
        if !cwd.is_absolute() {
            return Err(scope("An absolute isolated Worktree path is required."));
        }
        let real = fs::canonicalize(cwd).map_err(io_error)?;
        let entry = state
            .entries
            .get(&real)
            .filter(|entry| entry.removed.is_none())
            .ok_or_else(|| {
                scope("Only Worktrees created by this isolated Git owner can be changed.")
            })?;
        if identity(&real)? != entry.identity || !real.starts_with(&self.0.root) {
            return Err(scope("The isolated Worktree was replaced."));
        }
        if fs::canonicalize(&self.0.common).map_err(io_error)? != self.0.common
            || fs::symlink_metadata(&self.0.common)
                .map_err(io_error)?
                .file_type()
                .is_symlink()
        {
            return Err(scope("The isolated Git directory was replaced."));
        }
        let common = self
            .checked(
                &real,
                &["rev-parse", "--git-common-dir"],
                None,
                READ_TIMEOUT,
            )
            .await?;
        if fs::canonicalize(real.join(crate::trim(&common))).map_err(io_error)? != self.0.common {
            return Err(scope("This Worktree belongs to another repository."));
        }
        let top = self
            .checked(&real, &["rev-parse", "--show-toplevel"], None, READ_TIMEOUT)
            .await?;
        if fs::canonicalize(crate::trim(&top)).map_err(io_error)? != real {
            return Err(scope("This folder isn't the top of an isolated Worktree."));
        }
        Ok(real)
    }
    async fn helpers_safe(&self, cwd: &Path) -> Result<(), GitError> {
        // A metadata symlink could redirect a Git write into another repository.
        let mut pending = vec![self.0.common.clone()];
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(folder).map_err(io_error)? {
                let entry = entry.map_err(io_error)?;
                let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
                if metadata.file_type().is_symlink()
                    || (metadata.is_file() && metadata.nlink() != 1)
                {
                    return Err(scope(
                        "Linked Git metadata is not supported in isolated writes.",
                    ));
                }
                if metadata.is_dir() {
                    pending.push(entry.path());
                }
            }
        }
        let config = self.run(cwd, &["config", "--local", "--name-only", "--get-regexp", "^(include\\.|includeif\\.|filter\\.|extensions\\.worktreeconfig$|core\\.hookspath$|core\\.worktree$)"], None, READ_TIMEOUT).await;
        if config.ok && !crate::trim(&config.stdout).is_empty() {
            return Err(scope("Custom includes, filters, worktree config and hook paths are not supported in isolated writes."));
        }
        if !config.ok && config.code != Some(1) {
            return Err(config);
        }
        Ok(())
    }
    pub async fn lease(&self, worktree: &OwnedWorktree) -> Result<WorktreeLease, GitError> {
        let state = self.0.lane.lock().await;
        self.check_handle(worktree, &state)?;
        let path = self.validate(worktree.path(), &state).await?;
        *self
            .0
            .leases
            .lock()
            .unwrap()
            .entry(path.clone())
            .or_default() += 1;
        Ok(WorktreeLease {
            repository: self.0.clone(),
            path,
        })
    }
    fn check_handle(&self, worktree: &OwnedWorktree, state: &State) -> Result<(), GitError> {
        if worktree.owner != self.0.nonce
            || !state
                .entries
                .get(worktree.path())
                .is_some_and(|entry| entry.id == worktree.id)
        {
            return Err(scope(
                "This Worktree handle belongs to another isolated owner.",
            ));
        }
        Ok(())
    }
}
