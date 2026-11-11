use super::*;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorktree {
    pub project_path: PathBuf,
    pub base_branch: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(default)]
    pub folder_slug: Option<String>,
    #[serde(default)]
    pub track_base: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub uncommitted: u64,
    pub unpushed: u64,
    pub branch: Option<String>,
    pub head: String,
    pub removable: bool,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveOptions {
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub seen: Option<WorktreeStatus>,
}

fn slug(text: &str) -> String {
    let ascii: String = text
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .flat_map(char::to_lowercase)
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                ' '
            }
        })
        .collect();
    ascii
        .split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .into()
}
fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && branch != "@"
        && branch != "HEAD"
        && !branch.starts_with("refs/")
        && !branch.contains("@{")
        && !branch
            .chars()
            .any(|c| c < '\u{21}' || c == '\u{7f}' || " ~^:?*[\\".contains(c))
        && !branch.contains("..")
        && !branch.starts_with('/')
        && !branch.ends_with('/')
        && !branch.ends_with('.')
        && !branch.contains("//")
        && branch
            .split('/')
            .all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

impl IsolatedGit {
    async fn listed(&self) -> Result<Vec<Value>, GitError> {
        let result = if self.0.nul_listing.load(Ordering::Relaxed) {
            Some(
                self.run(
                    self.project_path(),
                    &["worktree", "list", "--porcelain", "-z"],
                    None,
                    READ_TIMEOUT,
                )
                .await,
            )
        } else {
            None
        };
        let records: Vec<Vec<String>> = if let Some(result) =
            result.as_ref().filter(|result| result.ok)
        {
            result
                .stdout
                .split("\0\0")
                .filter(|record| !record.is_empty())
                .map(|record| record.split('\0').map(str::to_owned).collect())
                .collect()
        } else if result.as_ref().is_none_or(|result| {
            result.code == Some(129) || result.stderr.to_lowercase().contains("unknown switch 'z'")
        }) {
            self.0.nul_listing.store(false, Ordering::Relaxed);
            self.checked(
                self.project_path(),
                &["worktree", "list", "--porcelain"],
                None,
                READ_TIMEOUT,
            )
            .await?
            .replace("\r\n", "\n")
            .split("\n\n")
            .filter(|record| !record.is_empty())
            .map(|record| record.lines().map(str::to_owned).collect())
            .collect()
        } else {
            return Err(result.unwrap());
        };
        Ok(records.into_iter().filter_map(|record| {
            let path = record.iter().find_map(|line| line.strip_prefix("worktree "))?;
            let branch = record.iter().find_map(|line| line.strip_prefix("branch ")).map(|branch| branch.strip_prefix("refs/heads/").unwrap_or(branch));
            Some(json!({"path":path,"name":branch.unwrap_or_else(||Path::new(path).file_name().and_then(|p|p.to_str()).unwrap_or(path))}))
        }).collect())
    }
    pub async fn list_worktrees(&self) -> Result<Value, GitError> {
        let state = self.0.lane.lock().await;
        self.validate(self.project_path(), &state).await?;
        Ok(json!(self.listed().await?))
    }
    async fn start_ref(&self, base: &str) -> String {
        let Some(upstream) = self
            .out(
                self.project_path(),
                &[
                    "for-each-ref",
                    "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)",
                    &format!("refs/heads/{base}"),
                ],
            )
            .await
        else {
            return base.into();
        };
        let fields: Vec<_> = upstream.split('\0').collect();
        if fields.len() < 3
            || fields[0].is_empty()
            || fields[0] == "."
            || fields[1].is_empty()
            || fields[2].is_empty()
        {
            return base.into();
        }
        // Existing tracking objects only. This capability never fetches.
        if self
            .run(
                self.project_path(),
                &[
                    "merge-base",
                    "--is-ancestor",
                    "--end-of-options",
                    base,
                    fields[2],
                ],
                None,
                READ_TIMEOUT,
            )
            .await
            .ok
        {
            fields[2].into()
        } else {
            base.into()
        }
    }
    pub async fn create_worktree(
        &self,
        request: CreateWorktree,
    ) -> Result<OwnedWorktree, GitError> {
        let mut state = self.0.lane.lock().await;
        let project = self.validate(&request.project_path, &state).await?;
        if project != self.0.project {
            return Err(scope(
                "Worktrees must be created from this isolated Project's main checkout.",
            ));
        }
        let base = &request.base_branch;
        if base.is_empty()
            || base.starts_with('-')
            || base.contains(['\0', '\n'])
            || self.commit_of(&project, base).await.is_none()
        {
            return Err(GitError::validation(
                "INVALID_ARGUMENT",
                format!(
                    "The base branch {} is missing from this project.",
                    json!(base)
                ),
            ));
        }
        if request
            .branch
            .as_deref()
            .is_some_and(|branch| !valid_branch(branch))
        {
            return Err(GitError::validation(
                "INVALID_ARGUMENT",
                format!(
                    "{} is not a valid branch name.",
                    json!(request.branch.as_deref().unwrap())
                ),
            ));
        }
        let suffix = request
            .suffix
            .unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..4].into());
        if suffix.is_empty()
            || suffix.len() > 16
            || !suffix
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            return Err(GitError::validation(
                "INVALID_ARGUMENT",
                "An isolated Worktree suffix must contain 1 to 16 lowercase letters or digits.",
            ));
        }
        let generated = slug(
            request
                .branch
                .as_deref()
                .map(|branch| branch.rsplit('/').next().unwrap())
                .unwrap_or(&request.prompt),
        );
        let chosen = request
            .folder_slug
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&generated);
        if !chosen.is_empty()
            && (chosen.len() > 40
                || chosen.starts_with('-')
                || chosen.ends_with('-')
                || !chosen
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
        {
            return Err(GitError::validation(
                "INVALID_ARGUMENT",
                "An isolated folder slug must be a branch-safe slug of at most 40 characters.",
            ));
        }
        let name = format!(
            "{}-{suffix}",
            if chosen.is_empty() { "chat" } else { chosen }
        );
        let branch = request.branch.unwrap_or_else(|| format!("milagre/{name}"));
        let root = self.worktree_root();
        if fs::canonicalize(&root).map_err(io_error)? != root
            || identity(&root)? != self.0.worktrees_identity
        {
            return Err(scope("The isolated Worktree destination was replaced."));
        }
        let parent = root.join("project");
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(scope("The isolated Worktree destination was replaced.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&parent).map_err(io_error)?
            }
            Err(error) => return Err(io_error(error)),
        }
        if fs::canonicalize(&parent).map_err(io_error)? != parent
            || !parent.starts_with(&self.0.root)
        {
            return Err(scope(
                "The isolated Worktree destination escaped its owner.",
            ));
        }
        let path = parent.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            return Err(scope("The isolated Worktree destination already exists."));
        }
        self.helpers_safe(&project).await?;
        let start = self.start_ref(base).await;
        self.checked(
            &project,
            &[
                "worktree",
                "add",
                if request.track_base {
                    "--track"
                } else {
                    "--no-track"
                },
                "-b",
                &branch,
                "--end-of-options",
                path.to_str()
                    .ok_or_else(|| scope("A UTF-8 Worktree path is required."))?,
                &start,
            ],
            None,
            WRITE_TIMEOUT,
        )
        .await?;
        let id = Uuid::new_v4().to_string();
        state.entries.insert(
            path.clone(),
            Entry {
                id: id.clone(),
                identity: identity(&path)?,
                base: Some(start.clone()),
                removed: None,
            },
        );
        self.validate(&path, &state).await?;
        Ok(OwnedWorktree {
            owner: self.0.nonce.clone(),
            id,
            path,
            branch,
            base: start,
        })
    }
    async fn status(&self, cwd: &Path, base: &str) -> Result<WorktreeStatus, GitError> {
        let porcelain = self
            .checked(
                cwd,
                &["status", "--porcelain", "--untracked-files=all"],
                None,
                READ_TIMEOUT,
            )
            .await?;
        let uncommitted = porcelain
            .split('\n')
            .filter(|line| !line.is_empty())
            .count() as u64;
        let head = self.commit_of(cwd, "HEAD").await.ok_or_else(|| {
            GitError::validation("GIT_STATUS", "This worktree has no commits to check.")
        })?;
        let name = self
            .checked(
                cwd,
                &["rev-parse", "--abbrev-ref", "HEAD"],
                None,
                READ_TIMEOUT,
            )
            .await?;
        let name = crate::trim(&name);
        let branch = (name != "HEAD").then(|| name.to_owned());
        let base_commit = self.commit_of(cwd, base).await.ok_or_else(|| {
            GitError::validation(
                "GIT_STATUS",
                "This worktree's base can't be found, so its commits can't be checked.",
            )
        })?;
        let upstream = if branch.is_some() {
            self.commit_of(cwd, "@{upstream}").await
        } else {
            None
        };
        let mut argv = vec!["rev-list", "--count", &head, "--not"];
        if branch.is_none() {
            argv.extend(["--branches", "--remotes"]);
        }
        argv.push(&base_commit);
        if let Some(upstream) = &upstream {
            argv.push(upstream);
        }
        argv.push("--");
        let unpushed = crate::number(&self.checked(cwd, &argv, None, READ_TIMEOUT).await?);
        Ok(WorktreeStatus {
            removable: branch.is_some() && uncommitted == 0 && unpushed == 0,
            uncommitted,
            unpushed,
            branch,
            head,
        })
    }
    pub async fn worktree_status(
        &self,
        worktree: &OwnedWorktree,
    ) -> Result<WorktreeStatus, GitError> {
        let state = self.0.lane.lock().await;
        self.check_handle(worktree, &state)?;
        let path = self.validate(worktree.path(), &state).await?;
        self.status(&path, state.entries[&path].base.as_deref().unwrap())
            .await
    }
    pub async fn remove_worktree(
        &self,
        worktree: &OwnedWorktree,
        options: RemoveOptions,
    ) -> Result<Value, GitError> {
        let mut state = self.0.lane.lock().await;
        self.check_handle(worktree, &state)?;
        self.0.verify_root()?;
        if let Some(previous) = &state.entries[worktree.path()].removed {
            return Ok(
                json!({"removed":false,"alreadyRemoved":true,"branch":previous["branch"],"branchDeleted":false}),
            );
        }
        let path = self.validate(worktree.path(), &state).await?;
        if !path.starts_with(self.worktree_root())
            || path == self.0.project
            || path == self.worktree_root()
        {
            return Err(scope(
                "The main checkout and folders outside the isolated Worktree root are kept.",
            ));
        }
        if self
            .0
            .leases
            .lock()
            .unwrap()
            .get(&path)
            .copied()
            .unwrap_or(0)
            > 0
        {
            return Err(scope("Another owner still uses this Worktree. Release its provider or setup lease first."));
        }
        let listed = self.listed().await?;
        let main = listed
            .first()
            .and_then(|entry| entry["path"].as_str())
            .ok_or_else(|| scope("The Project's main checkout is missing."))?;
        if fs::canonicalize(main).map_err(io_error)? != self.0.project {
            return Err(scope("The isolated Project's main checkout changed."));
        }
        self.helpers_safe(&path).await?;
        let now = self
            .status(&path, state.entries[&path].base.as_deref().unwrap())
            .await?;
        let unchanged = options.seen.as_ref().is_some_and(|seen| {
            now.head == seen.head
                && now.uncommitted <= seen.uncommitted
                && now.unpushed <= seen.unpushed
        });
        if if options.force {
            !unchanged
        } else {
            !now.removable
        } {
            return Err(GitError::validation(
                "WORKTREE_CHANGED",
                format!(
                    "WORKTREE_CHANGED: {} changed after it was checked.",
                    path.display()
                ),
            ));
        }
        let mut argv = vec!["worktree", "remove"];
        if options.force {
            argv.push("--force");
        }
        argv.push(path.to_str().unwrap());
        self.checked(self.project_path(), &argv, None, WRITE_TIMEOUT)
            .await?;
        let mut branch_deleted = false;
        if let Some(branch) = now
            .branch
            .as_deref()
            .filter(|branch| branch.starts_with("milagre/"))
        {
            branch_deleted = self
                .run(
                    self.project_path(),
                    &["branch", if options.force { "-D" } else { "-d" }, branch],
                    None,
                    WRITE_TIMEOUT,
                )
                .await
                .ok;
        }
        let result = json!({"removed":true,"branch":now.branch,"branchDeleted":branch_deleted});
        state.entries.get_mut(&path).unwrap().removed = Some(result.clone());
        Ok(result)
    }
}
