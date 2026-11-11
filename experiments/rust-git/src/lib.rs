//! Read-only Git/Changes adapter, ported from the production Node Git client.
//! Roots are explicit Worktree admissions, not a general filesystem capability.
mod changes;
mod diff;
mod history;
mod process;
mod refs;

use process::Runner;
pub use process::{GitError, MAX_BUFFER, READ_TIMEOUT};
use serde_json::Value;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use tokio::sync::Mutex as AsyncMutex;

pub const METHODS: &[&str] = &[
    "git:changes",
    "git:history",
    "git:diff-files",
    "git:diff-file",
];
pub const UNSUPPORTED_MUTATIONS: &[&str] = &[
    "git:generate",
    "git:commit",
    "git:push",
    "git:open-pr",
    "git:pr-comment",
    "git:pr-review",
    "git:pr-merge",
];
const NOT_REPO: &str = "This chat's folder isn't a git repository.";
const PATHSPEC: &[&str] = &["--", ".", ":(exclude).milagre"];
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub struct GitReader {
    roots: Vec<PathBuf>,
    git: Runner,
    catalogs: AsyncMutex<VecDeque<Catalog>>,
    stats: Mutex<VecDeque<Stats>>,
}
#[derive(Clone)]
struct Catalog {
    cwd: PathBuf,
    branch: Option<String>,
    expires: Instant,
    branches: Vec<Value>,
    source: Option<String>,
    version: String,
}
#[derive(Clone)]
struct Stats {
    cwd: PathBuf,
    sha: String,
    retry_at: Option<Instant>,
    value: Value,
}

impl GitReader {
    /// Canonicalizes exact admitted directories. A Project's other Worktrees must
    /// each be admitted explicitly by its owner. Symlink aliases of a root work.
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Result<Self, GitError> {
        let mut canonical = Vec::new();
        for root in roots {
            if !root.is_absolute() {
                return Err(GitError::validation(
                    "GIT_SCOPE",
                    "The chat's folder must be an absolute path.",
                ));
            }
            let root = std::fs::canonicalize(root).map_err(|_| {
                GitError::validation("GIT_SCOPE", "An admitted Git folder must exist.")
            })?;
            if !root.is_dir() {
                return Err(GitError::validation(
                    "GIT_SCOPE",
                    "An admitted Git folder must be a directory.",
                ));
            }
            if !canonical.contains(&root) {
                canonical.push(root);
            }
        }
        Ok(Self {
            roots: canonical,
            git: Runner,
            catalogs: AsyncMutex::new(VecDeque::new()),
            stats: Mutex::new(VecDeque::new()),
        })
    }

    fn folder(&self, args: &Value) -> Result<PathBuf, GitError> {
        let cwd = args
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|s| !s.contains('\0'))
            .filter(|s| Path::new(s).is_absolute())
            .ok_or_else(|| {
                GitError::validation("GIT_SCOPE", "The chat's folder must be an absolute path.")
            })?;
        let canonical = std::fs::canonicalize(cwd).ok();
        canonical
            .filter(|p| self.roots.contains(p) && p.is_dir())
            .ok_or_else(|| {
                GitError::validation(
                    "GIT_SCOPE",
                    "This folder isn't one of the open project's chats.",
                )
            })
    }

    /// `args` is the object passed by the production renderer (cwd, base, mode,
    /// path, etc.). The daemon adapter owns Project/client authorization first.
    pub async fn call(&self, method: &str, args: Value) -> Result<Value, GitError> {
        if !METHODS.contains(&method) {
            return Err(GitError::validation(
                "UNSUPPORTED_METHOD",
                format!("{method} is not supported by the read-only Rust Git adapter."),
            ));
        }
        if !args.is_object() {
            return Err(GitError::validation(
                "INVALID_ARGUMENT",
                "Git arguments must be an object.",
            ));
        }
        let cwd = self.folder(&args)?;
        // Reject malformed ref values before building argv. A leading dash remains
        // a missing base, as in Node; it is never passed to an option-taking query.
        for name in ["base", "recordedBase"] {
            if let Some(value) = args.get(name).filter(|v| !v.is_null()) {
                if value.as_str().is_none_or(|s| s.contains('\0')) {
                    return Err(GitError::validation(
                        "INVALID_ARGUMENT",
                        format!("{name} must be a string."),
                    ));
                }
            }
        }
        match method {
            "git:changes" => self.changes(&cwd, &args).await,
            "git:history" => self.history(&cwd, &args).await,
            "git:diff-files" => self.diff_files(&cwd, &args).await,
            "git:diff-file" => self.diff_file(&cwd, &args).await,
            _ => unreachable!(),
        }
    }
}
fn string<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str)
}
fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|s| !s.is_empty())
}
fn sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn number(value: &str) -> u64 {
    trim(value).parse().unwrap_or(0)
}
// String.prototype.trim includes BOM and excludes NEL, unlike Rust's trim.
fn trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn checked_path(value: &Value) -> Result<&str, GitError> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && !s.contains('\0')
                && !Path::new(s).is_absolute()
                && !s.split(['/', '\\']).any(|part| part == "..")
        })
        .ok_or_else(|| {
            GitError::validation(
                "INVALID_ARGUMENT",
                "The file must be a path inside the chat's folder.",
            )
        })
}
