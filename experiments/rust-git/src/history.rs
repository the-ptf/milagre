use crate::{
    diff::numstat, nonempty, number, string, Catalog, GitError, GitReader, Stats, NOT_REPO,
    PATHSPEC,
};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};
const CACHE_TIME: Duration = Duration::from_secs(30);

impl GitReader {
    async fn catalog(&self, cwd: &Path, branch: &Option<String>) -> Result<Catalog, GitError> {
        // One bounded shared read also coalesces concurrent phone/desktop polls.
        let mut catalogs = self.catalogs.lock().await;
        if let Some(saved) = catalogs.iter().find(|saved| {
            saved.cwd == cwd && saved.branch == *branch && saved.expires > Instant::now()
        }) {
            return Ok(saved.clone());
        }
        let (refs, source) = tokio::join!(
            self.git.checked(
                cwd,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/heads/",
                    "refs/remotes/"
                ]
            ),
            self.created_from(cwd)
        );
        let branches: Vec<_> = crate::trim(&refs?).split('\n').filter(|s| !s.is_empty() && !s.ends_with("/HEAD"))
            .map(|r| json!({"ref":r,"name":r.strip_prefix("refs/heads/").or_else(|| r.strip_prefix("refs/remotes/")).unwrap_or(r)})).collect();
        let version = format!(
            "{:x}",
            Sha256::digest(serde_json::to_string(&branches).unwrap().as_bytes())
        );
        let catalog = Catalog {
            cwd: cwd.into(),
            branch: branch.clone(),
            expires: Instant::now() + CACHE_TIME,
            branches,
            source,
            version,
        };
        catalogs.retain(|saved| saved.cwd != cwd || saved.branch != *branch);
        if catalogs.len() >= 64 {
            catalogs.pop_front();
        }
        catalogs.push_back(catalog.clone());
        Ok(catalog)
    }

    async fn commit_stats(&self, cwd: &Path, sha: &str, parent: &str) -> Result<Value, GitError> {
        if let Some(saved) = self
            .stats
            .lock()
            .unwrap()
            .iter()
            .find(|saved| {
                saved.cwd == cwd
                    && saved.sha == sha
                    && saved.retry_at.is_none_or(|time| time > Instant::now())
            })
            .cloned()
        {
            return Ok(saved.value);
        }
        let mut argv = if parent.is_empty() {
            vec!["show", "--format="]
        } else {
            vec!["diff"]
        };
        argv.extend(["--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M"]);
        if !parent.is_empty() {
            argv.push(parent);
        }
        argv.push(sha);
        argv.extend(PATHSPEC);
        let (value, retry_at) = match self.git.checked(cwd, &argv).await {
            Ok(output) => {
                let files = numstat(&output);
                (
                    json!({"files":files.len(),"added":files.values().map(|file|file.added).sum::<u64>(),"removed":files.values().map(|file|file.removed).sum::<u64>()}),
                    None,
                )
            }
            Err(error) if error.timed_out || error.overflow => (
                json!({"files":null,"added":null,"removed":null,"statsUnavailable":if error.overflow { "tooLarge" } else { "timeout" }}),
                Some(Instant::now() + CACHE_TIME),
            ),
            Err(error) => return Err(error),
        };
        let mut cache = self.stats.lock().unwrap();
        cache.retain(|saved| saved.cwd != cwd || saved.sha != sha);
        if cache.len() >= 600 {
            cache.pop_front();
        }
        cache.push_back(Stats {
            cwd: cwd.into(),
            sha: sha.into(),
            value: value.clone(),
            retry_at,
        });
        Ok(value)
    }

    pub(crate) async fn history(&self, cwd: &Path, args: &Value) -> Result<Value, GitError> {
        if !self
            .git
            .run(cwd, &["rev-parse", "--is-inside-work-tree"])
            .await
            .ok
        {
            return Ok(json!({"isRepo":false,"message":NOT_REPO}));
        }
        let (branch, head) = tokio::join!(
            self.git
                .out(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
            self.git.out(cwd, &["rev-parse", "--verify", "HEAD"])
        );
        let catalog = self.catalog(cwd, &branch).await?;
        let recorded_base = nonempty(string(args, "recordedBase"));
        let base = nonempty(string(args, "base"));
        let automatic_source = recorded_base.or(catalog.source.as_deref());
        let automatic = self.resolve_base(cwd, automatic_source).await;
        let project_default = self.resolve_base(cwd, None).await;
        let base_exists = match base {
            Some(base) => self.ref_exists(cwd, base).await,
            None => true,
        };
        let resolved = if base.is_some() && base != automatic_source {
            self.resolve_base(cwd, base).await
        } else {
            automatic.clone()
        };
        let recorded = match recorded_base {
            Some(base) => self.ref_exists(cwd, base).await,
            None => false,
        };
        let suggestion_source = if recorded {
            recorded_base
        } else {
            catalog.source.as_deref()
        };
        let suggested = match suggestion_source {
            Some(source) if !source.starts_with('-') && self.ref_exists(cwd, source).await => {
                self.git
                    .out(cwd, &["rev-parse", "--symbolic-full-name", source])
                    .await
            }
            _ => None,
        };
        let mut automatic_value = automatic.value();
        automatic_value["reason"] = json!(if recorded {
            "the recorded base"
        } else if recorded_base.is_none() && catalog.source.is_some() && suggested.is_some() {
            "the branch it was created from"
        } else {
            "the project default"
        });
        let mut result = json!({"isRepo":true,"branch":branch,"head":head,"base":resolved.name,"comparisonRef":resolved.reference,
            "branchesVersion":catalog.version,"baseMissing":!base_exists,"automatic":automatic_value,"projectDefault":project_default.value(),"suggested":suggested,"commits":[],"hasMore":false,"total":0});
        if string(args, "branchesVersion") != Some(catalog.version.as_str()) {
            result["branches"] = json!(catalog.branches);
        }
        if head.is_none() {
            return Ok(result);
        }
        let Some(reference) = resolved.reference else {
            result["message"] = json!("No comparison branch available.");
            return Ok(result);
        };
        let Some(merge_base) = self.git.out(cwd, &["merge-base", &reference, "HEAD"]).await else {
            result["message"] = json!(format!(
                "This branch shares no history with {}.",
                resolved.name
            ));
            return Ok(result);
        };
        let range = format!("{merge_base}..HEAD");
        result["total"] = json!(number(
            &self
                .git
                .out(cwd, &["rev-list", "--count", &range, "--"])
                .await
                .unwrap_or_default()
        ));
        let limit = args
            .get("limit")
            .and_then(Value::as_f64)
            .filter(|n| n.fract() == 0.0);
        if limit == Some(0.0) {
            return Ok(result);
        }
        let count = limit.map(|n| n.clamp(1.0, 300.0) as usize).unwrap_or(30);
        let log = self
            .git
            .checked(
                cwd,
                &[
                    "log",
                    "-z",
                    &format!("--max-count={}", count + 1),
                    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B",
                    &range,
                    "--",
                ],
            )
            .await?;
        let fields: Vec<_> = log.split('\0').collect();
        let commits: Vec<_> = fields.as_chunks::<6>().0.iter().collect();
        let detailed: Vec<_> = stream::iter(commits.iter().take(count).map(|fields| async move {
            let [sha, parents, author, email, date, message] = *fields;
            let stats = self.commit_stats(cwd, sha, parents.split(' ').next().unwrap_or("")).await?;
            let mut commit = json!({"sha":sha,"author":author,"email":email,"date":date,"message":crate::trim(message)});
            commit.as_object_mut().unwrap().extend(stats.as_object().unwrap().clone());
            Ok::<_, GitError>(commit)
        })).buffered(4).try_collect().await?;
        result["commits"] = json!(detailed);
        result["hasMore"] = json!(commits.len() > count);
        Ok(result)
    }
}
