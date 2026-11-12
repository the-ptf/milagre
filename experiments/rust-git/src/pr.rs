//! Local-only production PR diff reads, without remote lookup or fetch authority.
//!
//! Commit validation/peeling adapted from MonoCode `scm/review.rs::peel_commit`,
//! commit 09d04436babb39ad72198cdf22f735067027fc04.
//! Copyright (c) 2026 Nick. MIT licensed; see ../THIRD_PARTY_NOTICES.md.
use crate::{sha, string, GitError, GitReader};
use serde_json::{json, Value};
use std::path::Path;

impl GitReader {
    /// Commits on the admitted folder's HEAD that the PR head does not have, as
    /// Node's `localCommits` counts them: `git rev-list --count <head>..HEAD`.
    /// Like Node, anything unavailable (not a full lowercase SHA-1, a head this
    /// checkout lacks, a failed or non-numeric count) is 0, and so is a count
    /// that is not a positive safe integer. Only a `cwd` that is an admitted
    /// root can be asked; the read is as bounded and local as every other here.
    pub async fn local_commits(&self, cwd: &Path, head: &str) -> Result<u64, GitError> {
        let cwd = self.folder(&json!({"cwd":cwd}))?;
        if !sha(head) {
            return Ok(0);
        }
        let counted = self
            .git
            .out(&cwd, &["rev-list", "--count", &format!("{head}..HEAD")])
            .await;
        Ok(counted
            .and_then(|text| text.trim().parse::<u64>().ok())
            .filter(|count| (1..=9_007_199_254_740_991).contains(count))
            .unwrap_or(0))
    }

    // Adapted from MonoCode's peel_commit. Milagre admits full lowercase SHA-1
    // only, and retains its bounded/private runner rather than ambient Git.
    async fn pr_commit(&self, cwd: &Path, spec: &str) -> bool {
        if !sha(spec) {
            return false;
        }
        self.git
            .out(
                cwd,
                &["rev-parse", "--verify", &format!("{spec}^{{commit}}")],
            )
            .await
            .is_some()
    }

    pub(crate) async fn pr_read(
        &self,
        cwd: &Path,
        method: &str,
        args: &Value,
    ) -> Result<Value, GitError> {
        let (Some(base), Some(head)) = (
            string(args, "base").filter(|s| sha(s)),
            string(args, "head").filter(|s| sha(s)),
        ) else {
            return Ok(
                json!({"ok":false,"message":"This PR's commits aren't known yet. Refresh and try again."}),
            );
        };
        if !self.pr_commit(cwd, base).await || !self.pr_commit(cwd, head).await {
            // Node attempts a fetch before this result. This explicit read-only
            // capability cannot fetch, authenticate, mutate remotes or index.
            return Ok(if method == "pr:diff-files" {
                json!({"isRepo":true,"base":null,"files":[],"message":"Fetch this PR's commits to see its diff here."})
            } else {
                json!({"patch":"","binary":false,"tooLarge":false})
            });
        }
        let mut query = json!({"mode":"pr-range","base":base,"head":head});
        let result = if method == "pr:diff-files" {
            self.diff_files(cwd, &query).await
        } else {
            query["path"] = args["path"].clone();
            if let Some(old) = args.get("oldPath") {
                query["oldPath"] = old.clone();
            }
            self.diff_file(cwd, &query).await
        };
        Ok(result.unwrap_or_else(|error| json!({"ok":false,"message":error.message})))
    }
}
