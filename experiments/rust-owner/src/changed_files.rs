//! The changed files of a handoff's minimal brief (runtime.cjs `changedFiles`: `git status --porcelain` in the Chat's
//! worktree, or in each member of a Link Chat's worktrees with its alias in front), hardened:
//!
//! - **Admitted worktrees only.** Git runs only in a folder the owner admitted ([`GitGrants::admit`]): canonical,
//!   strictly inside the isolated copy, with a real `.git` folder (no `gitdir:` file, no `commondir`: no redirection to
//!   another repository), whose config has no `include`, `worktree` or `fsmonitor` setting. A path the Chat's state
//!   names is only ever looked up among them, never run in. Each run checks the folder again, then holds it and its
//!   `.git` (opened from the copy's own folder down, no link followed): their paths must lead to the held folders
//!   just before Git runs and again after, or there is no list.
//! - **Cleared environment.** `/usr/bin/git` with only `PATH=/usr/bin:/bin`, `HOME` the isolated copy, `LC_ALL=C`, no
//!   system or global config, `GIT_OPTIONAL_LOCKS=0`, no prompt, `GIT_DIR`/`GIT_WORK_TREE` pinned and discovery
//!   ceiling at the copy; `core.fsmonitor=false` and `core.hooksPath=/dev/null` on the command line.
//! - **Bounded.** 3 seconds per run and 6 for all members of a handoff (the deadline covers the config read too),
//!   1 MiB of Git output and 2 MiB of listed files for all members together (counted before each name is built),
//!   aliases of at most 256 bytes, at most [`MAX_MEMBERS`] members.
//! - **Pipes read without threads.** Nonblocking reads on the running thread until both pipes close. Git is owned
//!   from right after spawn (`Owned`): its exit is observed without reaping it (`waitid` with `WNOWAIT`), and on every
//!   path its whole process group is killed before it is reaped, exactly once (never a signal after the reap). After
//!   it exits the pipes may stay open half a second (a descendant); then the group goes and the run gives no list.
//!   A read or wait that fails (other than an interrupted read, retried) is no list too, never the output read so far.
//!   A descendant that left the group (`setsid`) isn't owned or signalled; it holds nothing of ours after the run.
//! - **Our children stay waitable.** The owner process must not make children unwaitable or reap ones it didn't
//!   spawn: no `SIGCHLD` set to `SIG_IGN`, no `SA_NOCLDWAIT`, no reaper waiting on any child (`waitpid(-1)`, `wait()`).
//!   A `SIGCHLD` handler is fine, and so is waiting on one's own children by pid. Audited (root, locked versions):
//!   tokio 1.54.1 `process::unix` (its `SIGCHLD` notification and orphan queue `try_wait` only its own children, by
//!   handle) and portable-pty 0.9.0 (resets `SIGCHLD` only in the child's `pre_exec`; waits its exact child) keep this;
//!   this crate's only other child, `ps` in ownership checks, is waited on by pid. If something still reaps Git first,
//!   the run loses it: `waitid` fails (`ECHILD`), Git's pid is never signalled or waited on again (it may be another
//!   process's by then), its group isn't killed, and the run gives no list. The first loss in a process is reported
//!   once on stderr (no path or name in it); later ones only count. A reaper racing between the last check and the
//!   group kill can't be ruled out from inside this process; the requirement above is what rules it out.
//! - **Off the actor.** It runs inside the transcript job (`TranscriptJob::run`), on the runtime's blocking worker.
//!
//! Node's answer for anything that fails (a member not admitted, Git failing, a timeout) is no list at all
//! (`changedFiles().catch(() => [])`): the same here. Output is read as Node's `execFile(…, "utf8")` reads it and each
//! line becomes `line.slice(3)` (UTF-16), with the member's alias in front for a Link Chat. Deliberate differences:
//! Git's defaults apply where Node uses the person's own Git config (`core.quotePath`, global excludes), only a short
//! allow-list of the repository's own `core` settings is kept (how the folder is read: case, Unicode composition, file
//! modes, symlinks, ctime, stat, line ends), and submodules are never opened, so a submodule's own changes aren't
//! listed.
//! - **The repository's own Git folder isn't Git's.** Each run gets a private Git folder in `.owner/git` (removed
//!   after): a plain config with only that allow-list (read by `git config --no-includes -z` as data, each value
//!   read as Git reads it; one Git wouldn't take is no list),
//!   HEAD as the commit it names, a copy of the index and `info/exclude`, and the repository's objects through one
//!   alternate. All of it is read through descriptors from the held `.git` down (a link anywhere on the way is no
//!   list), and `git config` reads a private copy of the config bytes, never the repository's path. So no filter, hook, fsmonitor, include, `worktreeConfig`, replace ref or submodule the repository
//!   names is ever read or run; attributes files can name filters, but none is configured. A repository with
//!   extensions (SHA-256, reftables, `worktreeConfig`) or object alternates of its own gives no list.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::jsjson;
use crate::{Result, StoreError};

/// The most worktree members one handoff runs Git in.
pub const MAX_MEMBERS: usize = 16;
/// Git's output, all members together (bytes); more is no list.
const OUTPUT_LIMIT: usize = 1 << 20;
/// The listed files, aliases included, all members together (bytes); more is no list.
const LIST_LIMIT: usize = 2 << 20;
/// The longest alias a Link member may put in front of its files (bytes); a longer one is no list.
const MAX_ALIAS: usize = 256;
/// One run, then its whole process group is killed.
const TIMEOUT: Duration = Duration::from_secs(3);
/// All members of one handoff together.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(6);
/// How long the pipes may stay open once Git has exited or been killed.
const DRAIN: Duration = Duration::from_millis(500);
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
                        let alias = match member.get("alias") {
                            Some(serde_json::Value::String(alias)) if alias.len() > MAX_ALIAS => {
                                return None
                            }
                            Some(serde_json::Value::String(alias)) => alias.clone(),
                            // A number, a flag, null or none is short written as JavaScript would; a list or an
                            // object isn't an alias any member has (no list rather than writing it out).
                            other @ (None
                            | Some(
                                serde_json::Value::Null
                                | serde_json::Value::Bool(_)
                                | serde_json::Value::Number(_),
                            )) => jsjson::property_key(other),
                            Some(_) => return None,
                        };
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
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let mut output_left = OUTPUT_LIMIT;
    let mut list_bytes = 0usize;
    let mut files = Vec::new();
    for (alias, folder) in plan {
        check(copy, folder).ok()?;
        let output = status(copy, folder, deadline, output_left)?;
        output_left -= output.len();
        for line in output.split('\n').filter(|line| !line.is_empty()) {
            let units = jsjson::to_utf16(line);
            let name = &units[units.len().min(3)..];
            // Counted before anything is built: the alias, the slash and the name as UTF-8 (at most 3 bytes a unit).
            let needed = alias.as_ref().map_or(0, |alias| alias.len() + 1) + name.len() * 3;
            if list_bytes + needed > LIST_LIMIT {
                return None;
            }
            let name = jsjson::from_utf16(name);
            let file = match alias {
                Some(alias) => format!("{alias}/{name}"),
                None => name,
            };
            list_bytes += file.len();
            files.push(file);
        }
    }
    Some(files)
}

/// The settings of the repository's own config the run keeps (how the working folder is read, never commands).
const KEPT: [&str; 8] = [
    "core.ignorecase",
    "core.precomposeunicode",
    "core.filemode",
    "core.symlinks",
    "core.trustctime",
    "core.checkstat",
    "core.autocrlf",
    "core.eol",
];

/// A Git boolean as Git reads it (valueless is true, empty is false, any nonzero integer is true); `Err` where Git
/// would refuse the value.
fn git_bool(value: Option<&str>) -> std::result::Result<bool, ()> {
    let Some(value) = value else { return Ok(true) };
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" => Ok(true),
        "" | "false" | "no" | "off" => Ok(false),
        other => other.parse::<i64>().map(|n| n != 0).map_err(|_| ()),
    }
}

/// A kept setting's value written as Git would take it, or `Err` when Git would refuse it, or (`core.eol`) read it as
/// unset: the run gives no list rather than reading the folder another way than Git would.
fn kept_value(key: &str, value: Option<&str>) -> std::result::Result<String, ()> {
    let lower = value.map(str::to_ascii_lowercase);
    match key {
        "core.checkstat" => match lower.as_deref() {
            Some(word @ ("default" | "minimal")) => Ok(word.to_string()),
            _ => Err(()),
        },
        "core.autocrlf" if lower.as_deref() == Some("input") => Ok("input".into()),
        "core.eol" => match lower.as_deref() {
            Some(word @ ("lf" | "crlf" | "native")) => Ok(word.to_string()),
            _ => Err(()),
        },
        _ if KEPT.contains(&key) => git_bool(value).map(|on| on.to_string()),
        _ => Err(()),
    }
}

const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// The copy's own folder, held, after checking its path is canonical and leads to it.
fn open_copy(copy: &Path) -> Option<OwnedFd> {
    let root = rustix::fs::openat(rustix::fs::CWD, copy, DIR_FLAGS, Mode::empty()).ok()?;
    leads_to(copy, &root).then_some(root)
}

/// `path` is canonical (no link on it or above it) and names the folder held as `fd`.
fn leads_to(path: &Path, fd: &OwnedFd) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    !meta.file_type().is_symlink()
        && Some((meta.dev(), meta.ino())) == identity(fd)
        && std::fs::canonicalize(path).ok().as_deref() == Some(path)
}

/// The admitted worktree and its `.git` for one run, opened from the copy's own folder down one component at a time,
/// never following a link. Git is given their paths, so each must still lead to the folder held just before Git runs
/// and again after (a folder swapped in under the same name, even a real one, is no list).
struct Tree {
    path: PathBuf,
    root: OwnedFd,
    git: OwnedFd,
    /// Given to Git (as the private folder's one alternate) by path, so held and checked like the others.
    objects: OwnedFd,
}

impl Tree {
    fn open(copy: &Path, folder: &Path) -> Option<Tree> {
        let mut dir = open_copy(copy)?;
        for part in folder.strip_prefix(copy).ok()?.components() {
            let std::path::Component::Normal(name) = part else {
                return None;
            };
            dir = rustix::fs::openat(&dir, name, DIR_FLAGS, Mode::empty()).ok()?;
        }
        let git = rustix::fs::openat(&dir, ".git", DIR_FLAGS, Mode::empty()).ok()?;
        let objects = rustix::fs::openat(&git, "objects", DIR_FLAGS, Mode::empty()).ok()?;
        let tree = Tree {
            path: folder.to_path_buf(),
            root: dir,
            git,
            objects,
        };
        tree.holds().then_some(tree)
    }

    fn holds(&self) -> bool {
        leads_to(&self.path, &self.root)
            && leads_to(&self.path.join(".git"), &self.git)
            && leads_to(&self.objects_path(), &self.objects)
    }

    fn objects_path(&self) -> PathBuf {
        self.path.join(".git").join("objects")
    }
}

/// A private Git folder for one run, inside the copy's `.owner/git`, removed when dropped: Git reads its config,
/// HEAD, refs and index from here, never from the repository's own `.git` (whose objects it reads through an
/// alternate only). So nothing the repository's config names (filters, fsmonitor, hooks, submodules, includes,
/// `worktreeConfig`, replace refs) is ever run or read.
///
/// Made, written and removed only through held descriptors (`mkdirat`, `openat` with `O_EXCL|O_NOFOLLOW`, `unlinkat`),
/// from the copy's own folder down; its path (what Git is given) is checked to lead to the held folder just before Git
/// runs and again after, and a mismatch is no list. (Git itself opens it by path in between.)
struct Scratch {
    path: PathBuf,
    parent: OwnedFd,
    name: String,
    dir: OwnedFd,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        remove_tree(&self.dir);
        let _ = rustix::fs::unlinkat(&self.parent, self.name.as_str(), AtFlags::REMOVEDIR);
    }
}

use rustix::fs::{AtFlags, Mode, OFlags};
use std::os::fd::OwnedFd;

fn identity(fd: &OwnedFd) -> Option<(u64, u64)> {
    let stat = rustix::fs::fstat(fd).ok()?;
    Some((stat.st_dev as u64, stat.st_ino as u64))
}

/// The folder `name` under `parent`, made (0700) if missing, opened without following a link.
fn folder_at(parent: &OwnedFd, name: &str, exclusive: bool) -> Option<OwnedFd> {
    match rustix::fs::mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
        Ok(()) => {}
        Err(rustix::io::Errno::EXIST) if !exclusive => {}
        Err(_) => return None,
    }
    rustix::fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()
}

/// A new file `name` under `dir` (exclusive, 0600, no link followed) holding `bytes`.
fn write_at(dir: &OwnedFd, name: &str, bytes: &[u8]) -> Option<()> {
    write_at_times(dir, name, bytes, None)
}

/// [`write_at`], then (with `times`) the file's access and modification times set through its descriptor.
fn write_at_times(
    dir: &OwnedFd,
    name: &str,
    bytes: &[u8],
    times: Option<&rustix::fs::Timestamps>,
) -> Option<()> {
    use std::io::Write;
    let file = rustix::fs::openat(
        dir,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .ok()?;
    let mut file = std::fs::File::from(file);
    file.write_all(bytes).ok()?;
    if let Some(times) = times {
        rustix::fs::futimens(&file, times).ok()?;
    }
    Some(())
}

/// The access and modification times of a file as `fstat` read them (seconds and nanoseconds).
fn times_of(stat: &rustix::fs::Stat) -> rustix::fs::Timestamps {
    rustix::fs::Timestamps {
        last_access: rustix::fs::Timespec {
            tv_sec: stat.st_atime as _,
            tv_nsec: stat.st_atime_nsec as _,
        },
        last_modification: rustix::fs::Timespec {
            tv_sec: stat.st_mtime as _,
            tv_nsec: stat.st_mtime_nsec as _,
        },
    }
}

/// Everything under the held folder `dir`, removed through descriptors (never by path).
fn remove_tree(dir: &OwnedFd) {
    let Ok(entries) = rustix::fs::Dir::read_from(dir) else {
        return;
    };
    let names: Vec<std::ffi::CString> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_owned())
        .filter(|name| name.as_bytes() != b"." && name.as_bytes() != b"..")
        .collect();
    for name in names {
        if rustix::fs::unlinkat(dir, name.as_c_str(), AtFlags::empty()).is_ok() {
            continue;
        }
        if let Ok(child) = rustix::fs::openat(
            dir,
            name.as_c_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            remove_tree(&child);
            let _ = rustix::fs::unlinkat(dir, name.as_c_str(), AtFlags::REMOVEDIR);
        }
    }
}

/// The file at `name` (`/`-separated) under the held folder `dir`, each folder on the way opened from the one before
/// without following a link, and at most `cap` bytes ever held: `Ok(None)` when it (or a folder on the way) doesn't
/// exist; `Err` when anything on the way is a link or not a folder, or the file is a link, not a plain file,
/// unreadable or larger than `cap`.
fn read_beneath(dir: &OwnedFd, name: &str, cap: u64) -> std::result::Result<Option<Vec<u8>>, ()> {
    Ok(read_beneath_stat(dir, name, cap)?.map(|(bytes, _)| bytes))
}

/// [`read_beneath`], with the file's `fstat` taken through the same descriptor the bytes were read from.
fn read_beneath_stat(
    dir: &OwnedFd,
    name: &str,
    cap: u64,
) -> std::result::Result<Option<(Vec<u8>, rustix::fs::Stat)>, ()> {
    let mut parts: Vec<&str> = name.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(());
    }
    let last = parts.pop().ok_or(())?;
    let mut held: Option<OwnedFd> = None;
    for part in parts {
        let at = held.as_ref().unwrap_or(dir);
        match rustix::fs::openat(at, part, DIR_FLAGS, Mode::empty()) {
            Ok(fd) => held = Some(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(()),
        }
    }
    let file = match rustix::fs::openat(
        held.as_ref().unwrap_or(dir),
        last,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(file) => file,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(()),
    };
    let stat = rustix::fs::fstat(&file).map_err(|_| ())?;
    if !rustix::fs::FileType::from_raw_mode(stat.st_mode).is_file() {
        return Err(());
    }
    let mut bytes = Vec::new();
    std::fs::File::from(file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > cap {
        return Err(());
    }
    Ok(Some((bytes, stat)))
}

/// A file that must be there (HEAD, config): `None` unless it reads.
fn required(dir: &OwnedFd, name: &str, cap: u64) -> Option<Vec<u8>> {
    read_beneath(dir, name, cap).ok().flatten()
}

fn hex_id(text: &str) -> bool {
    (text.len() == 40) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl Scratch {
    fn make(copy: &Path, tree: &Tree, deadline: Instant) -> Option<Scratch> {
        // The copy's own folder, held: everything below is made relative to it.
        let root = open_copy(copy)?;
        let owner = folder_at(&root, crate::isolation::OWNER_DIR, false)?;
        let parent = folder_at(&owner, "git", false)?;
        let mut random = [0u8; 8];
        std::fs::File::open("/dev/urandom")
            .ok()?
            .read_exact(&mut random)
            .ok()?;
        let name = hex::encode(random);
        let dir = folder_at(&parent, &name, true)?;
        let scratch = Scratch {
            path: copy
                .join(crate::isolation::OWNER_DIR)
                .join("git")
                .join(&name),
            parent,
            name,
            dir,
        };
        scratch.fill(copy, tree, deadline)?;
        Some(scratch)
    }

    /// The path Git is given still leads to the folder held (no link on it or above it).
    fn holds(&self) -> bool {
        leads_to(&self.path, &self.dir)
    }

    fn fill(&self, copy: &Path, tree: &Tree, deadline: Instant) -> Option<()> {
        // Everything is read under the held `.git`, never by path: a link anywhere on the way is no list.
        let git = &tree.git;
        let config = required(git, "config", 64 * 1024)?;
        let text = String::from_utf8_lossy(&config).to_ascii_lowercase();
        // A repository format this run can't read with a plain config (SHA-256 objects, reftables): no list.
        if text.contains("[extensions") {
            return None;
        }
        // HEAD as the commit it names (the branch doesn't show in porcelain output), or as is while unborn.
        let head = String::from_utf8(required(git, "HEAD", 4096)?).ok()?;
        let head = head.trim();
        let commit = match head.strip_prefix("ref: ") {
            Some(name)
                if name.starts_with("refs/")
                    && !name
                        .split('/')
                        .any(|part| part.is_empty() || part.starts_with('.')) =>
            {
                // A loose ref that is there but unreadable is no list; one that is absent may be packed.
                let loose = read_beneath(git, name, 4096).ok()?;
                match loose {
                    Some(bytes) => {
                        let id = String::from_utf8(bytes).ok()?.trim().to_string();
                        if !hex_id(&id) {
                            return None;
                        }
                        Some(id)
                    }
                    None => match read_beneath(git, "packed-refs", 16 << 20).ok()? {
                        Some(bytes) => String::from_utf8(bytes).ok()?.lines().find_map(|line| {
                            let (id, rest) = line.split_once(' ')?;
                            (rest == name && hex_id(id)).then(|| id.to_string())
                        }),
                        None => None,
                    },
                }
            }
            Some(_) => return None,
            None if hex_id(head) => Some(head.to_string()),
            None => return None,
        };
        let head = match &commit {
            Some(id) => format!("{id}\n"),
            None => format!("{head}\n"),
        };
        // Its objects must be its own: an alternate would have Git read another repository's. Anything there (or a
        // link on the way) is no list.
        if read_beneath(&tree.objects, "info/alternates", 4096) != Ok(None) {
            return None;
        }
        let objects = tree.objects_path();
        let dir = &self.dir;
        let refs = folder_at(dir, "refs", true)?;
        drop(refs);
        let objects_dir = folder_at(dir, "objects", true)?;
        let objects_info = folder_at(&objects_dir, "info", true)?;
        drop(folder_at(&objects_dir, "pack", true)?);
        let info = folder_at(dir, "info", true)?;
        write_at(dir, "HEAD", head.as_bytes())?;
        write_at(
            &objects_info,
            "alternates",
            format!("{}\n", objects.display()).as_bytes(),
        )?;
        // The index: absent is fine (nothing staged yet); there but a link, unreadable or too large is no list (a
        // status without it would differ). Its copy keeps the index file's own times (from the descriptor read):
        // Git re-hashes an entry whose mtime isn't older than the index file's ("racily clean"), so a copy stamped
        // later would trust a same-size edit whose mtime was kept, where Git on the repository itself checks it.
        if let Some((index, stat)) = read_beneath_stat(git, "index", 64 << 20).ok()? {
            write_at_times(dir, "index", &index, Some(&times_of(&stat)))?;
        }
        if let Some(exclude) = read_beneath(git, "info/exclude", 1 << 20).ok()? {
            write_at(&info, "exclude", &exclude)?;
        }
        // Only the allow-listed settings of the repository's config, read by Git as data (no includes), values
        // checked. A read that fails or times out is no list (exit 1 is "none of them set").
        let mut kept = String::from("[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
        // Git reads the bytes read above (a private copy), not the repository's config by path.
        write_at(dir, "source-config", &config)?;
        if !self.holds() {
            return None;
        }
        let mut read = Command::new(GIT);
        read.current_dir(&self.path)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", copy)
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_DIR", &self.path)
            .arg("config")
            .arg("--file")
            .arg(self.path.join("source-config"))
            .args([
                "--no-includes",
                "-z",
                "--get-regexp",
                "^core\\.(ignorecase|precomposeunicode|filemode|symlinks|trustctime|checkstat|autocrlf|eol)$",
            ]);
        let listed = run_bounded(read, deadline, 64 * 1024, true);
        rustix::fs::unlinkat(dir, "source-config", AtFlags::empty()).ok()?;
        let listed = listed.filter(|_| self.holds())?;
        // `-z`: each entry is `key\nvalue\0`, or `key\0` when valueless. Every one is kept, in order (the last wins, as
        // in Git), or the run gives no list.
        for entry in listed.split('\0').filter(|entry| !entry.is_empty()) {
            let (key, value) = match entry.split_once('\n') {
                Some((key, value)) => (key, Some(value)),
                None => (entry, None),
            };
            let value = kept_value(key, value).ok()?;
            kept.push_str(&format!("\t{} = {value}\n", &key[5..]));
        }
        write_at(dir, "config", kept.as_bytes())?;
        Some(())
    }
}

/// `git status --porcelain` in `folder` through a private Git folder (see [`Scratch`]), hardened (see the module docs);
/// its output read as UTF-8 (U+FFFD for invalid bytes, as Node's `encoding: "utf8"`), or `None`.
fn status(copy: &Path, folder: &Path, deadline: Instant, limit: usize) -> Option<String> {
    let tree = Tree::open(copy, folder)?;
    let scratch = Scratch::make(copy, &tree, deadline)?;
    #[cfg(feature = "test-fixtures")]
    test_hooks::run_before_status();
    // Git is given the worktree's and the private folder's paths: each must lead to the folder held, now and after.
    if !scratch.holds() || !tree.holds() {
        return None;
    }
    let mut command = Command::new(GIT);
    command
        .current_dir(folder)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", copy)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CEILING_DIRECTORIES", copy)
        .env("GIT_DIR", &scratch.path)
        .env("GIT_WORK_TREE", folder)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
            "core.excludesFile=/dev/null",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "submodule.recurse=false",
            "status",
            "--porcelain",
            "--ignore-submodules=all",
        ]);
    let output = run_bounded(
        command,
        deadline.min(Instant::now() + TIMEOUT),
        limit,
        false,
    );
    #[cfg(feature = "test-fixtures")]
    test_hooks::run_after_git();
    let output = output.filter(|_| scratch.holds() && tree.holds());
    drop(scratch);
    output
}

/// One nonblocking read of a pipe (tests can make the next one fail).
fn read_pipe(pipe: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    #[cfg(feature = "test-fixtures")]
    if let Some(kind) = test_hooks::take_read_failure() {
        return Err(std::io::Error::from(kind));
    }
    pipe.read(buffer)
}

/// A child owned exclusively from right after it is spawned, with its own process group (its pid). It is observed
/// with `waitid(WNOWAIT)`, which never reaps, so its pid, and with it its group id, can't be reused while it is held.
/// On every path (success, failure, timeout, a setup error, a panic) its whole group is killed and only then is it
/// reaped, exactly once; nothing is signalled after the reap. A descendant that left the group (`setsid`, `setpgid`)
/// isn't owned: it isn't signalled, and it holds none of ours once the pipes close.
///
/// Lost: if a wait fails (`ECHILD`: something else reaped it, such as `SIGCHLD` set to be ignored or a global
/// `waitpid(-1)` reaper; or any other error but `EINTR`, retried), the pid may already belong to another process, so
/// it is never signalled or waited on again and the run gives no list. Ownership is re-checked right before any
/// signal. The owner relies on nothing else in the process reaping children it didn't spawn (see the module docs).
struct Owned {
    child: std::process::Child,
    group: Option<rustix::process::Pid>,
    state: Ownership,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ownership {
    Held,
    Reaped,
    Lost,
}

impl Owned {
    fn new(child: std::process::Child) -> Owned {
        let group = rustix::process::Pid::from_raw(child.id() as i32);
        Owned {
            child,
            group,
            state: if group.is_some() {
                Ownership::Held
            } else {
                Ownership::Lost
            },
        }
    }

    /// One `waitid(EXITED|NOHANG|NOWAIT)`, never reaping, retried on `EINTR`; any other failure loses the child.
    fn probe(&mut self) -> std::io::Result<bool> {
        let pid = match (self.state, self.group) {
            (Ownership::Held, Some(pid)) => pid,
            _ => return Err(std::io::Error::other("the child isn't held")),
        };
        let options = rustix::process::WaitIdOptions::EXITED
            | rustix::process::WaitIdOptions::NOHANG
            | rustix::process::WaitIdOptions::NOWAIT;
        loop {
            #[cfg(feature = "test-fixtures")]
            let result = match test_hooks::take_wait_failure() {
                Some(errno) => Err(errno),
                None => rustix::process::waitid(rustix::process::WaitId::Pid(pid), options),
            };
            #[cfg(not(feature = "test-fixtures"))]
            let result = rustix::process::waitid(rustix::process::WaitId::Pid(pid), options);
            match result {
                Ok(status) => return Ok(status.is_some()),
                Err(rustix::io::Errno::INTR) => continue,
                Err(errno) => {
                    self.state = Ownership::Lost;
                    lost_child(errno);
                    #[cfg(feature = "test-fixtures")]
                    test_hooks::log("lost", self.child.id());
                    return Err(errno.into());
                }
            }
        }
    }

    /// Whether it exited, without reaping it (`Err`: the wait failed and the child is lost).
    fn exited(&mut self) -> std::io::Result<bool> {
        self.probe()
    }

    /// Kills its whole group (it is still unreaped, so the group id is its own), then reaps it: its exit status.
    /// Lost or reaped already: nothing at all.
    fn finish(&mut self) -> Option<std::process::ExitStatus> {
        // Still ours right before any signal (a child something else reaped is lost, never signalled).
        self.probe().ok()?;
        let pid = self.group?;
        #[cfg(feature = "test-fixtures")]
        test_hooks::log("signal", self.child.id());
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        // Unreaped, the pid is still its own: signalling it is safe even if it already exited.
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
        let status = self.child.wait();
        self.state = if status.is_ok() {
            Ownership::Reaped
        } else {
            Ownership::Lost
        };
        #[cfg(feature = "test-fixtures")]
        test_hooks::log(
            if status.is_ok() { "reap" } else { "lost" },
            self.child.id(),
        );
        status.ok()
    }
}

/// How many Git children this process lost (see `Owned`); the first is reported once on stderr.
static LOST_CHILDREN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn lost_child(errno: rustix::io::Errno) {
    if LOST_CHILDREN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
        eprintln!(
            "milagre owner: a Git child could not be waited on ({errno}); something else reaps child processes \
             (SIGCHLD ignored, SA_NOCLDWAIT or a wait-any reaper). Changed files are left out of handoff briefs \
             while that lasts; later losses aren't reported."
        );
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Runs `command` in its own process group, reading its pipes without threads (nonblocking, on this thread): `None`
/// past `deadline`, past `limit` bytes of output, when it fails (unless `exit_one_ok` and it exits 1), when a read or
/// wait fails, or when its pipes are still open DRAIN after it exits (a descendant holding them). Whatever happens,
/// its whole group is killed before it is reaped (see [`Owned`]), and the pipes are closed when this returns.
fn run_bounded(
    mut command: Command,
    deadline: Instant,
    limit: usize,
    exit_one_ok: bool,
) -> Option<String> {
    use std::os::unix::process::CommandExt;
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own process group: everything it starts is killed with it.
        .process_group(0)
        .spawn()
        .ok()?;
    // Owned from here: any early return below kills its group and reaps it.
    let mut owned = Owned::new(child);
    #[cfg(feature = "test-fixtures")]
    if test_hooks::run_before_setup(owned.child.id()) {
        return None;
    }
    let mut stdout = owned.child.stdout.take()?;
    let mut stderr = owned.child.stderr.take()?;
    for pipe in [
        std::os::fd::AsFd::as_fd(&stdout),
        std::os::fd::AsFd::as_fd(&stderr),
    ] {
        let flags = rustix::fs::fcntl_getfl(pipe).ok()?;
        rustix::fs::fcntl_setfl(pipe, flags | rustix::fs::OFlags::NONBLOCK).ok()?;
    }
    let mut out = Vec::new();
    let (mut out_open, mut err_open) = (true, true);
    let mut drained_by: Option<Instant> = None;
    let mut buffer = [0u8; 8192];
    loop {
        let mut progress = false;
        if out_open {
            match read_pipe(&mut stdout, &mut buffer) {
                Ok(0) => out_open = false,
                Ok(read) => {
                    progress = true;
                    // Kept up to one byte past the limit (to tell it was passed), the rest read and dropped.
                    let keep = (limit + 1).saturating_sub(out.len()).min(read);
                    out.extend_from_slice(&buffer[..keep]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => progress = true,
                // A read that fails isn't the end of the output: no list, never what was read so far.
                Err(_) => return None,
            }
        }
        if err_open {
            match read_pipe(&mut stderr, &mut buffer) {
                Ok(0) => err_open = false,
                Ok(_) => progress = true,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => progress = true,
                Err(_) => return None,
            }
        }
        if drained_by.is_none() && owned.exited().ok()? {
            drained_by = Some(Instant::now() + DRAIN);
        }
        if drained_by.is_some() && !out_open && !err_open {
            break;
        }
        let now = Instant::now();
        if drained_by.is_none() && now >= deadline {
            return None;
        }
        if drained_by.is_some_and(|by| now >= by) {
            // Exited, but something it started still holds a pipe: no output (its group goes on the way out).
            return None;
        }
        if !progress {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    // Exited and both pipes closed: anything it left in its group goes, then it is reaped.
    let status = owned.finish()?;
    let ok = status.success() || (exit_one_ok && status.code() == Some(1));
    if !ok || out.len() > limit {
        return None;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Test hooks: the bounded runner on any command, and a closure run right after Git (to change the config mid-run).
#[cfg(feature = "test-fixtures")]
pub mod test_hooks {
    use std::cell::RefCell;
    use std::time::Duration;

    type SetupHook = Box<dyn FnOnce(u32) -> bool>;

    thread_local! {
        static BEFORE_SETUP: RefCell<Option<SetupHook>> = const { RefCell::new(None) };
        static LOG: RefCell<Vec<(&'static str, u32)>> = const { RefCell::new(Vec::new()) };
        static WAIT_FAILURE: std::cell::Cell<Option<rustix::io::Errno>> = const { std::cell::Cell::new(None) };
        static AFTER_GIT: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
        static BEFORE_STATUS: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
        static READ_FAILURE: std::cell::Cell<Option<std::io::ErrorKind>> = const { std::cell::Cell::new(None) };
    }

    /// Runs `hook` with the child's pid right after the next bounded run (on this thread) spawns it, before its pipes
    /// are set up; `true` fails that setup (as a failed `fcntl` would).
    pub fn before_setup(hook: impl FnOnce(u32) -> bool + 'static) {
        BEFORE_SETUP.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn run_before_setup(pid: u32) -> bool {
        BEFORE_SETUP
            .with(|slot| slot.borrow_mut().take())
            .is_some_and(|hook| hook(pid))
    }

    pub(super) fn log(what: &'static str, pid: u32) {
        LOG.with(|log| log.borrow_mut().push((what, pid)));
    }

    /// What bounded runs on this thread did to their children, in order (taken): `"signal"` (its group and it were
    /// killed), `"reap"`, `"lost"` (a wait failed: never signalled or waited on again).
    pub fn take_process_log() -> Vec<(&'static str, u32)> {
        LOG.with(|log| std::mem::take(&mut *log.borrow_mut()))
    }

    /// The pids bounded runs reaped on this thread, each time it happened (taken, with the rest of the log).
    pub fn take_reaps() -> Vec<u32> {
        take_process_log()
            .into_iter()
            .filter(|(what, _)| *what == "reap")
            .map(|(_, pid)| pid)
            .collect()
    }

    /// The next `waitid` of a bounded run on this thread fails with `errno` (as a reaper elsewhere would make it fail
    /// with `ECHILD`).
    pub fn fail_next_wait(errno: i32) {
        WAIT_FAILURE.with(|slot| slot.set(Some(rustix::io::Errno::from_raw_os_error(errno))));
    }

    /// How many Git children this process lost so far (all threads).
    pub fn lost_children() -> u64 {
        super::LOST_CHILDREN.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn take_wait_failure() -> Option<rustix::io::Errno> {
        WAIT_FAILURE.with(|slot| slot.take())
    }

    /// The next pipe read of a bounded run (on this thread) fails with `kind` before reading anything.
    pub fn fail_next_read(kind: std::io::ErrorKind) {
        READ_FAILURE.with(|slot| slot.set(Some(kind)));
    }

    pub(super) fn take_read_failure() -> Option<std::io::ErrorKind> {
        READ_FAILURE.with(|slot| slot.take())
    }

    /// Runs `hook` once, after the private Git folder is filled (its config read) and before `git status` runs.
    pub fn before_status(hook: impl FnOnce() + 'static) {
        BEFORE_STATUS.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn run_before_status() {
        if let Some(hook) = BEFORE_STATUS.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }

    pub fn after_git(hook: impl FnOnce() + 'static) {
        AFTER_GIT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn run_after_git() {
        if let Some(hook) = AFTER_GIT.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }

    pub fn run_bounded(
        program: &str,
        args: &[&str],
        timeout: Duration,
        limit: usize,
    ) -> Option<String> {
        let mut command = std::process::Command::new(program);
        command.args(args);
        super::run_bounded(command, std::time::Instant::now() + timeout, limit, false)
    }
}
