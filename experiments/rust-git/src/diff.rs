use crate::{
    checked_path, number, sha, string, GitError, GitReader, EMPTY_TREE, NOT_REPO, PATHSPEC,
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

const FILE_LIMIT: usize = 1000;
const PATCH_LIMIT: usize = 1024 * 1024;
#[derive(Clone, Copy, Default)]
pub(crate) struct Counts {
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}
pub(crate) fn numstat(output: &str) -> BTreeMap<String, Counts> {
    let mut tokens = output.split('\0');
    let mut counts = BTreeMap::new();
    while let Some(record) = tokens.next() {
        if record.is_empty() {
            continue;
        }
        // Match the existing Node parser, including its treatment of a TAB in a path.
        let mut fields = record.split('\t');
        let added = fields.next().unwrap_or("");
        let removed = fields.next().unwrap_or("");
        let Some(mut file) = fields.next() else {
            continue;
        };
        if file.is_empty() {
            tokens.next();
            file = tokens.next().unwrap_or("");
        }
        let binary = added == "-" && removed == "-";
        counts.insert(
            file.into(),
            Counts {
                added: if binary { 0 } else { number(added) },
                removed: if binary { 0 } else { number(removed) },
                binary,
            },
        );
    }
    counts
}
fn name_status(output: &str) -> Vec<Value> {
    let mut tokens = output.split('\0');
    let mut files = Vec::new();
    while let Some(code) = tokens.next() {
        if code.is_empty() {
            continue;
        }
        let Some(file) = tokens.next() else {
            break;
        };
        match code.as_bytes().first() {
            Some(b'R') => if let Some(new) = tokens.next() { files.push(json!({"status":"renamed","oldPath":file,"path":new})); },
            Some(b'C') => if let Some(new) = tokens.next() { files.push(json!({"status":"added","path":new})); },
            first => files.push(json!({"status":match first { Some(b'A')=>"added",Some(b'D')=>"deleted",_=>"modified" },"path":file})),
        }
    }
    files
}
struct Refs {
    name: Option<String>,
    refs: Option<Vec<String>>,
    parent: Option<String>,
}
fn empty_patch(too_large: bool) -> Value {
    json!({"patch":"","binary":false,"tooLarge":too_large})
}

impl GitReader {
    async fn refs_for(&self, cwd: &Path, args: &Value) -> Result<Refs, GitError> {
        let mode = string(args, "mode");
        if let Some(commit) = args.get("commit").filter(|v| !v.is_null()) {
            let commit = commit
                .as_str()
                .filter(|s| mode == Some("committed") && sha(s))
                .ok_or_else(|| {
                    GitError::validation("INVALID_ARGUMENT", "A full commit SHA is required.")
                })?;
            self.git
                .checked(
                    cwd,
                    &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
                )
                .await?;
            let parents = self
                .git
                .checked(cwd, &["rev-list", "--parents", "-n", "1", commit, "--"])
                .await?;
            let parent = parents.split_whitespace().nth(1).map(str::to_owned);
            return Ok(Refs {
                name: Some(commit.into()),
                refs: Some(vec![
                    parent.clone().unwrap_or_else(|| EMPTY_TREE.into()),
                    commit.into(),
                ]),
                parent,
            });
        }
        // The IPC intentionally does not accept the internal PR range parameter.
        if mode == Some("range") {
            return Ok(Refs {
                name: None,
                refs: None,
                parent: None,
            });
        }
        let has_head = self.ref_exists(cwd, "HEAD").await;
        if mode != Some("committed") {
            return Ok(Refs {
                name: None,
                refs: Some(vec![if has_head { "HEAD" } else { EMPTY_TREE }.into()]),
                parent: None,
            });
        }
        let resolved = self.chat_base(cwd, string(args, "base")).await;
        let Some(reference) = resolved.reference else {
            return Ok(Refs {
                name: None,
                refs: None,
                parent: None,
            });
        };
        let merge_base = if has_head {
            self.git.out(cwd, &["merge-base", &reference, "HEAD"]).await
        } else {
            None
        };
        Ok(Refs {
            name: Some(resolved.name),
            refs: merge_base.map(|base| vec![base, "HEAD".into()]),
            parent: None,
        })
    }

    async fn untracked_file(&self, cwd: &Path, file: &str) -> Value {
        let result = self
            .git
            .run(
                cwd,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-index",
                    "--numstat",
                    "--",
                    "/dev/null",
                    file,
                ],
            )
            .await;
        let mut fields = result.stdout.split('\t');
        let added = fields.next().unwrap_or("");
        let removed = fields.next().unwrap_or("");
        let binary = added == "-" && removed == "-";
        json!({"path":file,"status":"added","added":if binary { 0 } else { number(added) },"removed":0,"binary":binary,"untracked":true})
    }

    pub(crate) async fn diff_files(&self, cwd: &Path, args: &Value) -> Result<Value, GitError> {
        if !self
            .git
            .run(cwd, &["rev-parse", "--is-inside-work-tree"])
            .await
            .ok
        {
            return Ok(json!({"isRepo":false,"message":NOT_REPO}));
        }
        let resolved = self.refs_for(cwd, args).await?;
        let Some(refs) = resolved.refs else {
            return Ok(match resolved.name {
                Some(name) => {
                    json!({"isRepo":true,"base":name,"files":[],"message":format!("This branch shares no history with {name}.")})
                }
                None => json!({"isRepo":true,"base":null,"files":[]}),
            });
        };
        let mut status_args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "-M",
        ];
        status_args.extend(refs.iter().map(String::as_str));
        status_args.extend(PATHSPEC);
        let mut count_args = status_args.clone();
        count_args[3] = "--numstat";
        let (status, counts) = tokio::try_join!(
            self.git.checked(cwd, &status_args),
            self.git.checked(cwd, &count_args)
        )?;
        let counts = numstat(&counts);
        let mut files = name_status(&status);
        for file in &mut files {
            let count = counts
                .get(file["path"].as_str().unwrap_or(""))
                .copied()
                .unwrap_or_default();
            file["added"] = json!(count.added);
            file["removed"] = json!(count.removed);
            file["binary"] = json!(count.binary);
        }
        let mut truncated = files.len() > FILE_LIMIT;
        if !matches!(string(args, "mode"), Some("committed" | "range")) {
            let mut list_args = vec!["ls-files", "--others", "--exclude-standard", "-z"];
            list_args.extend(PATHSPEC);
            let listed = self.git.run(cwd, &list_args).await;
            let candidates: Vec<_> = listed
                .stdout
                .split('\0')
                .filter(|s| !s.is_empty())
                .collect();
            let available = FILE_LIMIT.saturating_sub(files.len());
            truncated |= candidates.len() > available;
            let extra: Vec<_> = stream::iter(
                candidates
                    .into_iter()
                    .take(available)
                    .map(|file| self.untracked_file(cwd, file)),
            )
            .buffered(8)
            .collect()
            .await;
            files.extend(extra);
        }
        files.truncate(FILE_LIMIT);
        let mut result = json!({"isRepo":true,"base":resolved.name,"files":files});
        if let Some(commit) = args.get("commit").filter(|v| !v.is_null()) {
            result["commit"] = commit.clone();
            result["commitParent"] = json!(resolved.parent);
        }
        if truncated {
            result["truncated"] = json!(true);
        }
        Ok(result)
    }

    async fn untracked_inside(&self, cwd: &Path, file: &str) -> bool {
        let literal = format!(":(literal){file}");
        let mut argv = vec![
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            &literal,
        ];
        argv.extend(PATHSPEC);
        let listed = self.git.run(cwd, &argv).await;
        listed.ok
            && listed.stdout.split('\0').any(|path| path == file)
            && std::fs::canonicalize(cwd.join(file)).is_ok_and(|path| path.starts_with(cwd))
    }

    pub(crate) async fn diff_file(&self, cwd: &Path, args: &Value) -> Result<Value, GitError> {
        let file = checked_path(&args["path"])?;
        let old = args
            .get("oldPath")
            .filter(|v| !v.is_null())
            .map(checked_path)
            .transpose()?;
        let untracked = args.get("commit").is_none_or(Value::is_null)
            && args.get("untracked").is_some_and(|v| *v == true)
            && !matches!(string(args, "mode"), Some("committed" | "range"));
        let result = if untracked {
            if !self.untracked_inside(cwd, file).await {
                return Ok(empty_patch(false));
            }
            self.git
                .run(
                    cwd,
                    &[
                        "diff",
                        "--no-color",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-index",
                        "-U3",
                        "--",
                        "/dev/null",
                        file,
                    ],
                )
                .await
        } else {
            let Some(refs) = self.refs_for(cwd, args).await?.refs else {
                return Ok(empty_patch(false));
            };
            let mut specs = vec![format!(":(literal){file}")];
            if let Some(old) = old.filter(|old| *old != file && !old.is_empty()) {
                specs.push(format!(":(literal){old}"));
            }
            let mut argv = vec![
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "-U3",
            ];
            argv.extend(refs.iter().map(String::as_str));
            argv.push("--");
            argv.extend(specs.iter().map(String::as_str));
            self.git.run(cwd, &argv).await
        };
        if result.overflow {
            return Ok(empty_patch(true));
        }
        if !result.ok && !(untracked && result.code == Some(1)) {
            return Ok(empty_patch(false));
        }
        // JavaScript measures UTF-16 code units, not UTF-8 bytes.
        if result.stdout.encode_utf16().count() > PATCH_LIMIT {
            return Ok(empty_patch(true));
        }
        let binary = result.stdout.lines().any(|line| {
            line == "GIT binary patch"
                || (line.starts_with("Binary files ") && line.ends_with(" differ"))
        });
        Ok(
            json!({"patch":if binary { "" } else { &result.stdout },"binary":binary,"tooLarge":false}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nul_parsers_preserve_newlines_unicode_renames_copies_and_binary() {
        let files = name_status("R100\0old\nfile\0new é\0C100\0source\0copy\0U\0conflicted\0");
        assert_eq!(
            files[0],
            json!({"status":"renamed","oldPath":"old\nfile","path":"new é"})
        );
        assert_eq!(files[1], json!({"status":"added","path":"copy"}));
        assert_eq!(files[2]["status"], "modified");
        let stats = numstat("2\t1\t\0old\nfile\0new é\0-\t-\tbinary\0");
        assert_eq!(stats["new é"].added, 2);
        assert!(stats["binary"].binary);
    }
}
