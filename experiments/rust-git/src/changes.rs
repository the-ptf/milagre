use crate::{diff::numstat, number, string, GitError, GitReader, EMPTY_TREE, NOT_REPO, PATHSPEC};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

pub const GITHUB_UNAVAILABLE: &str =
    "GitHub PR lookup is not available in the read-only Rust Git adapter.";
pub(crate) fn looks_secret(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file).to_lowercase();
    if name.starts_with(".env") {
        return !matches!(
            name.as_str(),
            ".env.example" | ".env.sample" | ".env.template"
        );
    }
    [".pem", ".key", ".p8"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.contains("credential")
        || name.contains("secret")
}
fn line_count(cwd: &Path, file: &str) -> u64 {
    let read = || -> Option<u64> {
        let path = std::fs::canonicalize(cwd.join(file)).ok()?;
        if !path.starts_with(cwd) {
            return None;
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options.open(path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 1024 * 1024 {
            return None;
        }
        // Keep the read bounded even if another process grows the file after stat.
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 1024 * 1024 || bytes.contains(&0) {
            return None;
        }
        Some(
            bytes.iter().filter(|b| **b == b'\n').count() as u64
                + u64::from(!bytes.ends_with(b"\n")),
        )
    };
    read().unwrap_or(0)
}

impl GitReader {
    async fn changed_files(&self, cwd: &Path) -> Vec<Value> {
        let mut argv = vec![
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ];
        argv.extend(PATHSPEC);
        let status = self.git.run(cwd, &argv).await;
        let entries: Vec<_> = if status.ok {
            status
                .stdout
                .split('\0')
                .filter(|s| !s.is_empty())
                .take(300)
                .collect()
        } else {
            vec![]
        };
        let head = if self.ref_exists(cwd, "HEAD").await {
            "HEAD"
        } else {
            EMPTY_TREE
        };
        let mut argv = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "-z",
            "--no-renames",
            head,
        ];
        argv.extend(PATHSPEC);
        let result = self.git.run(cwd, &argv).await;
        let counts = numstat(if result.ok { &result.stdout } else { "" });
        let mut files: Vec<_> = entries.into_iter().filter_map(|entry| {
            let code = entry.get(..2)?; let file = entry.get(3..)?;
            let untracked = code == "??";
            let count = counts.get(file).copied().unwrap_or_default();
            let mut row = json!({"path":file,"status":if untracked || code.contains('A') { "added" } else if code.contains('D') { "deleted" } else { "modified" },
                "added":if untracked { line_count(cwd, file) } else { count.added },"removed":if untracked { 0 } else { count.removed }});
            if looks_secret(file) { row["secret"] = json!(true); }
            Some(row)
        }).collect();
        // JavaScript lexicographic string ordering is by UTF-16 code units.
        files.sort_by(|a, b| {
            a["path"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .cmp(b["path"].as_str().unwrap().encode_utf16())
        });
        files
    }
    async fn operation(&self, cwd: &Path) -> Option<String> {
        for (name, operation) in [
            ("MERGE_HEAD", "merge"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
        ] {
            if let Some(path) = self.git.out(cwd, &["rev-parse", "--git-path", name]).await {
                if cwd.join(path).exists() {
                    return Some(format!(
                        "A {operation} is in progress. Finish or abort it, then commit."
                    ));
                }
            }
        }
        self.git
            .out(cwd, &["ls-files", "-u"])
            .await
            .filter(|s| !s.is_empty())
            .map(|_| "Some files have unresolved conflicts. Resolve them, then commit.".into())
    }
    async fn unpushed(&self, cwd: &Path) -> u64 {
        if !self.ref_exists(cwd, "HEAD").await {
            return 0;
        }
        let argv = if self.ref_exists(cwd, "@{upstream}").await {
            vec!["rev-list", "--count", "@{upstream}..HEAD"]
        } else {
            vec!["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]
        };
        number(&self.git.out(cwd, &argv).await.unwrap_or_default())
    }
    pub(crate) async fn changes(&self, cwd: &Path, args: &Value) -> Result<Value, GitError> {
        let Some(top) = self
            .git
            .out(cwd, &["rev-parse", "--show-toplevel"])
            .await
            .filter(|s| !s.is_empty())
        else {
            return Ok(json!({"isRepo":false,"message":NOT_REPO}));
        };
        if std::fs::canonicalize(top).ok().as_deref() != Some(cwd) {
            return Ok(
                json!({"isRepo":false,"message":"This folder isn't the top of a git checkout."}),
            );
        }
        let (branch, files, remotes, unpushed, resolved, blocked) = tokio::join!(
            self.git
                .out(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
            self.changed_files(cwd),
            self.git.out(cwd, &["remote"]),
            self.unpushed(cwd),
            self.chat_base(cwd, string(args, "base")),
            self.operation(cwd)
        );
        let remotes: Vec<_> = remotes
            .as_deref()
            .unwrap_or("")
            .split('\n')
            .map(crate::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let origin = remotes.contains(&"origin");
        let on_base = branch.as_deref() == Some(resolved.name.as_str());
        let ahead = match &resolved.reference {
            Some(reference) => number(
                &self
                    .git
                    .out(cwd, &["rev-list", "--count", &format!("{reference}..HEAD")])
                    .await
                    .unwrap_or_default(),
            ),
            None => 0,
        };
        let gh_message = if origin && branch.is_some() && !on_base {
            Some(GITHUB_UNAVAILABLE)
        } else {
            None
        };
        Ok(
            json!({"isRepo":true,"branch":branch,"base":resolved.name,"hasChanges":!files.is_empty(),"files":files,"unpushed":unpushed,"ahead":ahead,
            "hasOrigin":origin,"remotes":remotes.len(),"prRepo":null,"onBase":on_base,"commitBlocked":blocked,"ghReady":false,"ghMessage":gh_message,"pr":null}),
        )
    }
}
