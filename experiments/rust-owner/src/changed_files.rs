//! The changed files of a handoff's minimal brief (runtime.cjs `changedFiles`: `git status --porcelain` in the Chat's
//! worktree, or in each member of a Link Chat's worktrees with its alias in front), hardened:
//!
//! - **Admitted worktrees only.** Git runs only in a folder the owner admitted ([`GitGrants::admit`]): canonical,
//!   strictly inside the isolated copy, with a real `.git` folder (no `gitdir:` file, no `commondir`: no redirection to
//!   another repository), whose config has no `include`, `worktree` or `fsmonitor` setting. A path the Chat's state
//!   names is only ever looked up among them, never run in. Each run checks the folder again.
//! - **Cleared environment.** `/usr/bin/git` with only `PATH=/usr/bin:/bin`, `HOME` the isolated copy, `LC_ALL=C`, no
//!   system or global config, `GIT_OPTIONAL_LOCKS=0`, no prompt, `GIT_DIR`/`GIT_WORK_TREE` pinned and discovery
//!   ceiling at the copy; `core.fsmonitor=false` and `core.hooksPath=/dev/null` on the command line.
//! - **Bounded.** 3 seconds per run (then killed), 1 MiB of output per pipe, at most [`MAX_MEMBERS`] members.
//! - **Off the actor.** It runs inside the transcript job (`TranscriptJob::run`), on the runtime's blocking worker.
//!
//! Node's answer for anything that fails (a member not admitted, Git failing, a timeout) is no list at all
//! (`changedFiles().catch(() => [])`): the same here. Output is read as Node's `execFile(…, "utf8")` reads it and each
//! line becomes `line.slice(3)` (UTF-16), with the member's alias in front for a Link Chat. Git's defaults apply (no
//! global config): `core.quotePath` quotes unusual names, where Node uses the person's own Git config.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::jsjson;
use crate::{Result, StoreError};

/// The most worktree members one handoff runs Git in.
pub const MAX_MEMBERS: usize = 16;
const OUTPUT_LIMIT: usize = 1 << 20;
const TIMEOUT: Duration = Duration::from_secs(3);
const GIT: &str = "/usr/bin/git";

/// The worktrees the owner may run Git in, all inside one isolated copy.
#[derive(Clone, Debug, Default)]
pub struct GitGrants {
    copy: PathBuf,
    admitted: Vec<PathBuf>,
}

/// Where one handoff's changed files come from: admitted folders, each with the alias a Link Chat's member puts in
/// front of its files (none for a plain Chat). `None` means no list (a member that isn't admitted).
pub type ChangedPlan = Option<Vec<(Option<String>, PathBuf)>>;

fn refused(why: String) -> StoreError {
    StoreError::NotIsolated(why)
}

impl GitGrants {
    /// No worktree admitted yet, inside the isolated copy at `copy`.
    pub fn new(copy: &Path) -> Self {
        GitGrants {
            copy: copy.to_path_buf(),
            admitted: Vec::new(),
        }
    }

    /// Admits `path` for `git status`, after the checks in the module docs.
    pub fn admit(&mut self, path: &Path) -> Result<()> {
        check(&self.copy, path)?;
        if !self.admitted.iter().any(|known| known == path) {
            self.admitted.push(path.to_path_buf());
        }
        Ok(())
    }

    pub fn admitted(&self) -> &[PathBuf] {
        &self.admitted
    }

    /// The plan for a Chat: its worktree folder, or its Link members (`[{ alias, worktreePath }]`), looked up among
    /// the admitted folders. Anything not admitted (or more than MAX_MEMBERS) gives no list, as a failing Node run does.
    pub fn plan(&self, cwd: Option<&str>, members: Option<&serde_json::Value>) -> ChangedPlan {
        let admitted = |text: &str| {
            let path = Path::new(text);
            self.admitted
                .iter()
                .find(|known| known.as_path() == path)
                .cloned()
        };
        match members {
            Some(serde_json::Value::Array(members)) => {
                if members.len() > MAX_MEMBERS {
                    return None;
                }
                members
                    .iter()
                    .map(|member| {
                        let alias = jsjson::property_key(member.get("alias"));
                        let path = member.get("worktreePath")?.as_str()?;
                        Some((Some(alias), admitted(path)?))
                    })
                    .collect()
            }
            Some(other) if !other.is_null() => None,
            _ => Some(vec![(None, admitted(cwd?)?)]),
        }
    }
}

/// The admission checks, run again before each Git run.
fn check(copy: &Path, path: &Path) -> Result<()> {
    let real =
        std::fs::canonicalize(path).map_err(|error| StoreError::io(error, "realpath", path))?;
    if real != path {
        return Err(refused(format!(
            "{} isn't a canonical path.",
            path.display()
        )));
    }
    if path == copy || !path.starts_with(copy) {
        return Err(refused(format!(
            "{} isn't inside the isolated copy {}.",
            path.display(),
            copy.display()
        )));
    }
    let git = path.join(".git");
    match std::fs::symlink_metadata(&git) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => {
            return Err(refused(format!(
                "{} has no .git folder of its own (a link or a gitdir file isn't admitted).",
                path.display()
            )))
        }
    }
    if std::fs::symlink_metadata(git.join("commondir")).is_ok() {
        return Err(refused(format!(
            "{} shares another repository's Git folder.",
            path.display()
        )));
    }
    let config = git.join("config");
    match std::fs::symlink_metadata(&config) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 64 * 1024 => {
        }
        _ => {
            return Err(refused(format!(
                "{}'s Git config isn't a small plain file.",
                path.display()
            )))
        }
    }
    let text =
        std::fs::read_to_string(&config).map_err(|error| StoreError::io(error, "read", &config))?;
    let compact: String = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    for setting in ["[include", "includeif", "worktree=", "fsmonitor"] {
        if compact.contains(setting) {
            return Err(refused(format!(
                "{}'s Git config sets {setting}, which isn't admitted.",
                path.display()
            )));
        }
    }
    Ok(())
}

/// Runs `git status --porcelain` in each member of `plan` (checked again first) and lists the changed files as Node
/// does; `None` when anything fails. Blocking: call it off the owner's actor.
pub fn changed_files(copy: &Path, plan: &ChangedPlan) -> Option<Vec<String>> {
    let plan = plan.as_ref()?;
    let mut files = Vec::new();
    for (alias, folder) in plan {
        check(copy, folder).ok()?;
        let output = status(copy, folder)?;
        for line in output.split('\n').filter(|line| !line.is_empty()) {
            let units = jsjson::to_utf16(line);
            let name = jsjson::from_utf16(&units[units.len().min(3)..]);
            files.push(match alias {
                Some(alias) => format!("{alias}/{name}"),
                None => name,
            });
        }
    }
    Some(files)
}

/// `git status --porcelain` in `folder`, hardened (see the module docs); its output read as UTF-8 (U+FFFD for
/// invalid bytes, as Node's `encoding: "utf8"`), or `None`.
fn status(copy: &Path, folder: &Path) -> Option<String> {
    let mut child = Command::new(GIT)
        .current_dir(folder)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", copy)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CEILING_DIRECTORIES", copy)
        .env("GIT_DIR", folder.join(".git"))
        .env("GIT_WORK_TREE", folder)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "status",
            "--porcelain",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let read = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = (&mut pipe)
                .take(OUTPUT_LIMIT as u64 + 1)
                .read_to_end(&mut bytes);
            // Whatever is left is drained (never kept), so Git can't block on a full pipe.
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            bytes
        })
    };
    let stdout = read(Box::new(child.stdout.take()?));
    let stderr = read(Box::new(child.stderr.take()?));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = stdout.join().ok()?;
    let _ = stderr.join();
    if !status?.success() || out.len() > OUTPUT_LIMIT {
        return None;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}
