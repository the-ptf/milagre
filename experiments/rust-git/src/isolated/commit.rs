use super::*;
use crate::{changes::looks_secret, trim, PATHSPEC};

fn cap(text: &str) -> String {
    let units: Vec<_> = trim(text).encode_utf16().collect();
    if units.len() > 6000 {
        format!(
            "…\n{}",
            String::from_utf16_lossy(&units[units.len() - 6000..])
        )
    } else {
        trim(text).into()
    }
}
fn result(kind: &str, message: &str) -> Value {
    json!({"ok":false,"kind":kind,"message":message})
}
impl IsolatedGit {
    async fn blocked(&self, cwd: &Path) -> Option<String> {
        for (file, operation) in [
            ("MERGE_HEAD", "merge"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
        ] {
            if let Some(path) = self.out(cwd, &["rev-parse", "--git-path", file]).await {
                if cwd.join(path).exists() {
                    return Some(format!(
                        "A {operation} is in progress. Finish or abort it, then commit."
                    ));
                }
            }
        }
        self.out(cwd, &["ls-files", "-u"])
            .await
            .filter(|s| !s.is_empty())
            .map(|_| "Some files have unresolved conflicts. Resolve them, then commit.".into())
    }
    async fn hook_failed(&self, cwd: &Path, output: &str) -> bool {
        let lower = output.to_lowercase();
        if [
            "please tell me who you are",
            "author identity unknown",
            "nothing to commit",
            "empty commit message",
            "unable to auto-detect email",
            "could not lock",
            "index.lock",
        ]
        .iter()
        .any(|part| lower.contains(part))
        {
            return false;
        }
        for hook in ["pre-commit", "prepare-commit-msg", "commit-msg"] {
            if let Some(path) = self
                .out(cwd, &["rev-parse", "--git-path", &format!("hooks/{hook}")])
                .await
            {
                if fs::metadata(cwd.join(path)).is_ok_and(|metadata| metadata.mode() & 0o111 != 0) {
                    return true;
                }
            }
        }
        false
    }
    async fn signing_safe(&self, cwd: &Path) -> bool {
        if self
            .out(cwd, &["config", "--bool", "--get", "commit.gpgsign"])
            .await
            .as_deref()
            != Some("true")
        {
            return true;
        }
        let format = self
            .out(cwd, &["config", "--get", "gpg.format"])
            .await
            .unwrap_or_else(|| "openpgp".into());
        // Git prefers the format-specific helper over the legacy gpg.program.
        let program = match self
            .out(cwd, &["config", "--get", "gpg.openpgp.program"])
            .await
        {
            Some(program) => Some(program),
            None => self.out(cwd, &["config", "--get", "gpg.program"]).await,
        };
        // No system GPG, SSH agent, keychain or user signing identity in fixtures.
        format == "openpgp"
            && program.is_some_and(|program| {
                fs::canonicalize(program)
                    .is_ok_and(|path| path.starts_with(&self.0.root) && path.is_file())
            })
    }
    /// Production `git:commit` domain result. Stages all changes except `.milagre`,
    /// preserves secret refusal/index restoration and passes the message on stdin.
    pub async fn commit(&self, cwd: &Path, message: &str) -> Result<Value, GitError> {
        let state = self.0.lane.lock().await;
        let cwd = self.validate(cwd, &state).await?;
        let text = trim(message);
        if text.is_empty() {
            return Ok(result("error", "Write a commit message first."));
        }
        if let Some(message) = self.blocked(&cwd).await {
            return Ok(result("blocked", &message));
        }
        if self
            .out(&cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .is_none()
        {
            return Ok(
                json!({"ok":false,"kind":"blocked","message":"Check out a branch to commit.","code":"DETACHED_COMMIT"}),
            );
        }
        self.helpers_safe(&cwd).await?;
        if !self.signing_safe(&cwd).await {
            return Ok(result("signing", "Only a signing helper inside this temporary repository is permitted in isolated Git."));
        }
        let has_head = self.commit_of(&cwd, "HEAD").await.is_some();
        // Without a saved index tree a secret refusal cannot restore what the
        // caller had staged. Refuse before git add changes the index.
        let before = self
            .checked(&cwd, &["write-tree"], None, WRITE_TIMEOUT)
            .await?;
        let before = trim(&before);
        let mut argv = vec!["add", "-A"];
        argv.extend(PATHSPEC);
        let added = self.run(&cwd, &argv, None, WRITE_TIMEOUT).await;
        if !added.ok {
            return Ok(result(
                "error",
                &cap(if added.stderr.is_empty() {
                    &added.stdout
                } else {
                    &added.stderr
                }),
            ));
        }
        let argv = if has_head {
            vec!["reset", "-q", "--", ".milagre"]
        } else {
            vec![
                "rm",
                "-r",
                "-q",
                "--cached",
                "--ignore-unmatch",
                "--",
                ".milagre",
            ]
        };
        // A failed exclusion must never leave .milagre staged for commit.
        self.checked(&cwd, &argv, None, WRITE_TIMEOUT).await?;
        let listed = self
            .run(
                &cwd,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--cached",
                    "--name-only",
                    "-z",
                    "--no-renames",
                    "--diff-filter=AM",
                ],
                None,
                READ_TIMEOUT,
            )
            .await;
        // Unlike an optional status probe, a failed safety check cannot permit commit.
        if !listed.ok {
            return Err(listed);
        }
        let secrets: Vec<_> = listed
            .stdout
            .split('\0')
            .filter(|file| !file.is_empty() && looks_secret(file))
            .collect();
        if !secrets.is_empty() {
            if !before.is_empty() {
                self.checked(&cwd, &["read-tree", before], None, WRITE_TIMEOUT)
                    .await?;
                self.run(
                    &cwd,
                    &["update-index", "-q", "--refresh"],
                    None,
                    WRITE_TIMEOUT,
                )
                .await;
            }
            return Ok(result("secrets", &format!("These look like secrets and would be committed: {}. Add them to .gitignore, or commit them yourself if you mean to.", secrets.join(", "))));
        }
        let changes = self
            .run(
                &cwd,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--cached",
                    "--quiet",
                ],
                None,
                READ_TIMEOUT,
            )
            .await;
        if changes.ok {
            return Ok(result("nothing", "There's nothing to commit."));
        }
        if changes.code != Some(1) {
            return Err(changes);
        }
        let committed = self
            .run(
                &cwd,
                &["commit", "-F", "-"],
                Some(format!("{text}\n").into_bytes()),
                WRITE_TIMEOUT,
            )
            .await;
        if !committed.ok {
            let output = cap(&[committed.stdout.as_str(), committed.stderr.as_str()]
                .into_iter()
                .filter(|part| !trim(part).is_empty())
                .collect::<Vec<_>>()
                .join("\n"));
            if committed.timed_out {
                return Ok(
                    json!({"ok":false,"kind":"error","message":"The commit took too long and was stopped.","output":output}),
                );
            }
            let lower = output.to_lowercase();
            if [
                "gpg failed",
                "failed to sign",
                "signing failed",
                "signing key",
            ]
            .iter()
            .any(|part| lower.contains(part))
            {
                return Ok(result("signing", &output));
            }
            if self.hook_failed(&cwd, &output).await {
                return Ok(
                    json!({"ok":false,"kind":"hook","message":"The commit failed in a git hook.","output":output}),
                );
            }
            return Ok(result(
                "error",
                if output.is_empty() {
                    "The commit failed."
                } else {
                    &output
                },
            ));
        }
        let (sha, short) = tokio::join!(
            self.out(&cwd, &["rev-parse", "HEAD"]),
            self.out(&cwd, &["rev-parse", "--short", "HEAD"])
        );
        Ok(json!({"ok":true,"sha":sha,"shortSha":short}))
    }
}
