use crate::{nonempty, GitReader};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Debug)]
pub(crate) struct Base {
    pub name: String,
    pub reference: Option<String>,
}
impl Base {
    pub fn value(&self) -> Value {
        json!({"name":self.name,"ref":self.reference})
    }
}
impl GitReader {
    pub(crate) async fn ref_exists(&self, cwd: &Path, reference: &str) -> bool {
        !reference.contains('\0')
            && self
                .git
                .run(
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
                .ok
    }
    pub(crate) async fn resolve_base(&self, cwd: &Path, recorded: Option<&str>) -> Base {
        if let Some(recorded) = nonempty(recorded).filter(|s| !s.starts_with('-')) {
            if self.ref_exists(cwd, recorded).await {
                if let Some(full) = self
                    .git
                    .out(cwd, &["rev-parse", "--symbolic-full-name", recorded])
                    .await
                {
                    let name = full.strip_prefix("refs/heads/").or_else(|| {
                        full.strip_prefix("refs/remotes/")
                            .and_then(|s| s.split_once('/').map(|(_, name)| name))
                    });
                    if let Some(name) = name {
                        if full.starts_with("refs/heads/") {
                            let upstream = self
                                .git
                                .out(cwd, &["for-each-ref", "--format=%(upstream)", &full])
                                .await
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| format!("refs/remotes/origin/{name}"));
                            if upstream.starts_with("refs/remotes/")
                                && self.ref_exists(cwd, &upstream).await
                                && !self
                                    .git
                                    .run(
                                        cwd,
                                        &[
                                            "merge-base",
                                            "--is-ancestor",
                                            "--end-of-options",
                                            &upstream,
                                            &full,
                                        ],
                                    )
                                    .await
                                    .ok
                            {
                                return Base {
                                    name: name.into(),
                                    reference: Some(upstream),
                                };
                            }
                        }
                        return Base {
                            name: name.into(),
                            reference: Some(recorded.into()),
                        };
                    }
                }
            }
        }
        let remote_head = self
            .git
            .out(
                cwd,
                &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
            )
            .await
            .filter(|s| !s.is_empty());
        let name = if let Some(head) = remote_head {
            head.strip_prefix("refs/remotes/origin/")
                .unwrap_or(&head)
                .to_owned()
        } else if self.ref_exists(cwd, "refs/heads/main").await
            || self.ref_exists(cwd, "refs/remotes/origin/main").await
        {
            "main".into()
        } else if self.ref_exists(cwd, "refs/heads/master").await
            || self.ref_exists(cwd, "refs/remotes/origin/master").await
        {
            "master".into()
        } else {
            "main".into()
        };
        for reference in [
            format!("refs/remotes/origin/{name}"),
            format!("refs/heads/{name}"),
        ] {
            if self.ref_exists(cwd, &reference).await {
                return Base {
                    name,
                    reference: Some(reference),
                };
            }
        }
        Base {
            name,
            reference: None,
        }
    }
    pub(crate) async fn created_from(&self, cwd: &Path) -> Option<String> {
        let branch = self
            .git
            .out(cwd, &["symbolic-ref", "--quiet", "HEAD"])
            .await?;
        let name = branch.strip_prefix("refs/heads/")?;
        let entries = self
            .git
            .out(
                cwd,
                &[
                    "log",
                    "--walk-reflogs",
                    "--format=%gs",
                    "--end-of-options",
                    &branch,
                ],
            )
            .await?;
        let from = entries
            .lines()
            .last()?
            .strip_prefix("branch: Created from ")?;
        if from.is_empty()
            || from == "HEAD"
            || ((7..=64).contains(&from.len()) && from.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return None;
        }
        let remote_name = from
            .strip_prefix("refs/remotes/")
            .unwrap_or(from)
            .split_once('/')
            .map(|(_, branch)| branch);
        if from == name || remote_name == Some(name) {
            None
        } else {
            Some(from.into())
        }
    }
    pub(crate) async fn chat_base(&self, cwd: &Path, recorded: Option<&str>) -> Base {
        let source = if nonempty(recorded).is_none() {
            self.created_from(cwd).await
        } else {
            None
        };
        self.resolve_base(cwd, nonempty(recorded).or(source.as_deref()))
            .await
    }
}
