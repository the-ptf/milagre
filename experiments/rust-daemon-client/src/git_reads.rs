//! Typed, read-only Git access to the captured dedicated Project.
use super::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GitHistoryOptions {
    pub base: Option<String>,
    pub recorded_base: Option<String>,
    pub branches_version: Option<String>,
    /// Zero requests metadata without commit rows. Omitted means daemon default.
    pub limit: Option<u16>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GitDiffMode {
    #[default]
    Uncommitted,
    Committed,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
/// Only supported diff options. The Project's working directory is not selectable.
/// ```compile_fail
/// use milagre_daemon_client::GitDiffOptions;
/// let options = GitDiffOptions { cwd: "/tmp".into(), ..Default::default() };
/// ```
pub struct GitDiffOptions {
    pub mode: GitDiffMode,
    pub base: Option<String>,
    /// Full lowercase SHA-1, admitted only in committed mode.
    pub commit: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GitDiffFileOptions {
    pub diff: GitDiffOptions,
    pub old_path: Option<String>,
    /// Only meaningful in uncommitted mode; incompatible combinations refuse.
    pub untracked: bool,
}

/// Weak reads for one opened dedicated Project. No cwd selection, raw arguments,
/// mutations, PR actions, ambient discovery, or implicit connections are exposed.
#[derive(Clone)]
pub struct GitReads {
    handle: Weak<Handle>,
}
impl Client {
    pub(crate) fn owned_git_for(&self, authority: &Arc<Authority>) -> Result<GitReads> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !Weak::ptr_eq(&self.handle.authority, &Arc::downgrade(authority)) {
            return Err(Error::InvalidScope);
        }
        Ok(GitReads {
            handle: Arc::downgrade(&self.handle),
        })
    }
}
fn text(value: &str, field: &'static str, max: usize) -> Result<()> {
    if value.len() > max || value.contains('\0') {
        return Err(input(
            field,
            "Git string exceeds its byte limit or contains NUL",
        ));
    }
    Ok(())
}
fn reference(argument: &mut Value, name: &'static str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        text(value, name, 1024)?;
        argument[name] = json!(value);
    }
    Ok(())
}
fn relative_path(value: &str, field: &'static str) -> Result<()> {
    text(value, field, 4096)?;
    if value.is_empty()
        || std::path::Path::new(value).is_absolute()
        || value.starts_with('\\')
        || value.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(input(
            field,
            "Expected a nonempty relative repository path without traversal",
        ));
    }
    Ok(())
}
impl GitDiffOptions {
    fn apply(&self, argument: &mut Value) -> Result<()> {
        argument["mode"] = json!(match self.mode {
            GitDiffMode::Uncommitted => "uncommitted",
            GitDiffMode::Committed => "committed",
        });
        reference(argument, "base", self.base.as_deref())?;
        if let Some(commit) = &self.commit {
            if self.mode != GitDiffMode::Committed
                || commit.len() != 40
                || !commit
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(input(
                    "commit",
                    "Expected a full lowercase SHA-1 in committed mode",
                ));
            }
            argument["commit"] = json!(commit);
        }
        Ok(())
    }
}
impl GitReads {
    fn client(&self) -> Result<Client> {
        let handle = self.handle.upgrade().ok_or(Error::Disconnected)?;
        if handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !handle.opened_view.load(Ordering::Acquire) {
            return Err(Error::ViewNotOpened);
        }
        Ok(Client { handle })
    }
    fn argument(client: &Client) -> Value {
        json!({"cwd":client.handle.project})
    }
    fn enqueue(
        client: Client,
        method: &'static str,
        argument: Value,
    ) -> Result<reply::Receiver<Value>> {
        let args = json!([argument]);
        if args.to_string().len() > 64 * 1024 {
            return Err(input("payload", "Encoded Git arguments exceed 64 KiB"));
        }
        let (reply, wait) = reply::channel();
        client.submit(Kind::Call {
            method,
            args,
            reply,
        })?;
        Ok(wait)
    }
    pub async fn changes(&self, base: Option<&str>) -> Result<Value> {
        let client = self.client()?;
        let mut argument = Self::argument(&client);
        reference(&mut argument, "base", base)?;
        Self::enqueue(client, "git:changes", argument)?.await
    }
    pub async fn history(&self, options: GitHistoryOptions) -> Result<Value> {
        let client = self.client()?;
        let mut argument = Self::argument(&client);
        reference(&mut argument, "base", options.base.as_deref())?;
        reference(
            &mut argument,
            "recordedBase",
            options.recorded_base.as_deref(),
        )?;
        if let Some(version) = options.branches_version {
            text(&version, "branchesVersion", 128)?;
            argument["branchesVersion"] = json!(version);
        }
        if let Some(limit) = options.limit {
            if limit > 300 {
                return Err(input("limit", "Expected 0..=300 commit rows"));
            }
            argument["limit"] = json!(limit);
        }
        Self::enqueue(client, "git:history", argument)?.await
    }
    pub async fn diff_files(&self, options: GitDiffOptions) -> Result<Value> {
        let client = self.client()?;
        let mut argument = Self::argument(&client);
        options.apply(&mut argument)?;
        Self::enqueue(client, "git:diff-files", argument)?.await
    }
    pub async fn diff_file(&self, path: &str, options: GitDiffFileOptions) -> Result<Value> {
        let client = self.client()?;
        relative_path(path, "path")?;
        let mut argument = Self::argument(&client);
        options.diff.apply(&mut argument)?;
        argument["path"] = json!(path);
        if let Some(old_path) = options.old_path {
            relative_path(&old_path, "oldPath")?;
            argument["oldPath"] = json!(old_path);
        }
        if options.untracked {
            if options.diff.mode != GitDiffMode::Uncommitted {
                return Err(input(
                    "untracked",
                    "Untracked patches require uncommitted mode",
                ));
            }
            argument["untracked"] = json!(true);
        }
        Self::enqueue(client, "git:diff-file", argument)?.await
    }
}
