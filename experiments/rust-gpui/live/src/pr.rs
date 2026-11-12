//! The PR panel on Milagre's daemon, as Electron's `PullRequestPanel.tsx` drives it through `window.milagre.pr`:
//!
//! - Reads ([`Daemon::read`], short request-only connections): `pr:detail [{cwd, number}]` (`cwd` the Chat's Worktree
//!   folder) when the panel's Chat names a PR, every [`POLL`] while the window is active, after every write and on the
//!   Project's `pull-requests:changed`; then the PR's files as Electron's diff reads them (`pr:diff-files [{cwd, base,
//!   head}]`, `pr:diff-file [{cwd, base, head, path, oldPath}]` for up to [`PATCHES`] files, `base`/`head` the PR's
//!   `baseRefOid`/`headRefOid`, read again only when the head moved), and once per folder the pickers' lists
//!   (`pr:labels [{cwd}]`, `pr:reviewer-candidates [{cwd}]`). Every answer is `{ok, …}` or `{ok: false, message}`.
//! - Writes ([`Write`], on a short write connection; refused in read-only mode): `pr:merge [{cwd, number, method,
//!   admin}]` (Merge, Merge anyway), `{…, auto: true}` / `{…, disableAuto: true}` (auto-merge), `pr:ready [{cwd, number}]`
//!   and `{…, draft: true}`, `pr:request-reviewers`, `pr:set-labels`, `pr:reply`, `pr:comment`, `pr:resolve-thread`,
//!   `pr:delete-comment`, `pr:submit-review`. The panel shows each change at once and takes it back with the
//!   message when the daemon refuses ([`PrBridge::deferred`]); the PR is read again after either.
//!
//! [`snapshot`] decodes `pull-requests:snapshot` for the sidebar's PR chips and hover cards.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, Context, Entity, SharedString, Task};
use milagre_gpui_spike::data::PullRequestSnapshot;
use milagre_gpui_spike::logic::diff::git::{DiffFileResult, DiffStatus};
use milagre_gpui_spike::workspace::panel::Panel;
use milagre_gpui_spike::workspace::panel::pr::bridge::{PrBridge, Write};
use milagre_gpui_spike::workspace::panel::pr::model::{
    Check, Comment, Label, MergeMethod, Outcome, PrFile, PullRequestDetail, PullState, RepoLabel, ReviewDecision, Reviewer,
    ReviewerState, Side, Thread,
};
use serde_json::{Value, json};

use crate::daemon::Daemon;

/// How often the shown PR is read again while the window is active (`usePullRequest`'s poll).
pub const POLL: Duration = Duration::from_secs(30);
/// Files whose patch is read with a PR.
pub const PATCHES: usize = 200;

// ---- Decoding ----

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn count(value: &Value, key: &str) -> u32 {
    u32::try_from(value[key].as_u64().unwrap_or(0)).unwrap_or(u32::MAX)
}

fn at(value: &Value, key: &str) -> i64 {
    value[key].as_str().and_then(milagre_gpui_spike::logic::usage::time::parse_iso_ms).unwrap_or(0)
}

fn comment(value: &Value) -> Comment {
    Comment {
        id: text(value, "id"),
        author: text(value, "author"),
        body: text(value, "body"),
        created_at: at(value, "createdAt"),
        pending: value["pending"] == true,
    }
}

fn list<T>(value: &Value, key: &str, each: impl Fn(&Value) -> Option<T>) -> Vec<T> {
    value[key].as_array().map(|items| items.iter().filter_map(each).collect()).unwrap_or_default()
}

/// A `PullRequestDetail` (`packages/shared/src/pull-request-review.ts`) and its base and head commits.
#[derive(Clone, Debug, PartialEq)]
pub struct Read {
    pub detail: PullRequestDetail,
    pub base: String,
    pub head: String,
}

pub fn detail(pr: &Value) -> Option<Read> {
    let number = u32::try_from(pr["number"].as_u64()?).ok()?;
    let state = match pr["state"].as_str()? {
        "OPEN" => PullState::Open,
        "MERGED" => PullState::Merged,
        "CLOSED" => PullState::Closed,
        _ => return None,
    };
    let detail = PullRequestDetail {
        number,
        url: text(pr, "url"),
        title: text(pr, "title"),
        body: text(pr, "body"),
        state,
        is_draft: pr["isDraft"] == true,
        author: text(pr, "author"),
        created_at: at(pr, "createdAt"),
        updated_at: at(pr, "updatedAt"),
        base_ref_name: text(pr, "baseRefName"),
        head_ref_name: text(pr, "headRefName"),
        additions: count(pr, "additions"),
        deletions: count(pr, "deletions"),
        changed_files: count(pr, "changedFiles"),
        merge_state_status: text(pr, "mergeStateStatus"),
        review_decision: match pr["reviewDecision"].as_str() {
            Some("APPROVED") => Some(ReviewDecision::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewDecision::ChangesRequested),
            Some("REVIEW_REQUIRED") => Some(ReviewDecision::ReviewRequired),
            _ => None,
        },
        auto_merge: pr["autoMerge"]["method"].as_str().and_then(MergeMethod::from_key),
        viewer_can_merge_as_admin: pr["viewerCanMergeAsAdmin"] == true,
        viewer_is_author: pr["viewerIsAuthor"] == true,
        checks: list(pr, "checks", |c| {
            Some(Check {
                name: text(c, "name"),
                workflow: c["workflow"].as_str().map(str::to_owned),
                outcome: match c["outcome"].as_str()? {
                    "pass" => Outcome::Pass,
                    "fail" => Outcome::Fail,
                    "running" => Outcome::Running,
                    "skipped" => Outcome::Skipped,
                    _ => Outcome::Neutral,
                },
                url: c["url"].as_str().map(str::to_owned),
            })
        }),
        reviewers: list(pr, "reviewers", |r| {
            Some(Reviewer {
                login: r["login"].as_str()?.to_owned(),
                state: match r["state"].as_str()? {
                    "APPROVED" => ReviewerState::Approved,
                    "CHANGES_REQUESTED" => ReviewerState::ChangesRequested,
                    "COMMENTED" => ReviewerState::Commented,
                    "DISMISSED" => ReviewerState::Dismissed,
                    _ => ReviewerState::Requested,
                },
                stale: r["stale"] == true,
                team: r["team"] == true,
            })
        }),
        labels: list(pr, "labels", |l| Some(Label { name: l["name"].as_str()?.to_owned(), color: text(l, "color") })),
        files: list(pr, "files", |f| {
            Some(PrFile {
                path: f["path"].as_str()?.to_owned(),
                additions: count(f, "additions"),
                deletions: count(f, "deletions"),
                status: match f["status"].as_str() {
                    Some("added") => DiffStatus::Added,
                    Some("deleted") => DiffStatus::Deleted,
                    Some("renamed") => DiffStatus::Renamed,
                    _ => DiffStatus::Modified,
                },
            })
        }),
        threads: list(pr, "threads", |t| {
            Some(Thread {
                id: t["id"].as_str()?.to_owned(),
                path: text(t, "path"),
                line: t["line"].as_u64().and_then(|n| u32::try_from(n).ok()),
                side: if t["side"] == "LEFT" { Side::Left } else { Side::Right },
                resolved: t["resolved"] == true,
                outdated: t["outdated"] == true,
                comments: list(t, "comments", |c| Some(comment(c))),
            })
        }),
        comments: list(pr, "comments", |c| Some(comment(c))),
        pending_review: pr["pendingReview"]["count"].as_u64().and_then(|n| u32::try_from(n).ok()),
        local_commits: count(pr, "localCommits"),
    };
    Some(Read { detail, base: text(pr, "baseRefOid"), head: text(pr, "headRefOid") })
}

/// `{ok: true, pr}` or `{ok: false, message}` (`PullRequestDetailResult`).
pub fn detail_result(answer: &Value) -> Result<Read, String> {
    if answer["ok"] != true {
        return Err(answer["message"].as_str().unwrap_or("Couldn't read this PR.").to_owned());
    }
    detail(&answer["pr"]).ok_or_else(|| "Milagre answered with a PR this window can't read.".to_owned())
}

/// A write's answer (`PullRequestWriteResult`).
pub fn write_result(answer: &Value) -> Result<(), String> {
    if answer["ok"] == true {
        Ok(())
    } else {
        Err(answer["message"].as_str().unwrap_or("GitHub didn't take that change.").to_owned())
    }
}

/// One write as Electron's `window.milagre.pr` sends it: the command and its one request argument.
pub fn request(cwd: &str, number: u32, write: &Write) -> (&'static str, Value) {
    match write {
        Write::Merge { method, auto: Some(true), .. } => ("pr:merge", json!({"cwd": cwd, "number": number, "method": method.key(), "auto": true})),
        Write::Merge { method, auto: Some(false), .. } => {
            ("pr:merge", json!({"cwd": cwd, "number": number, "method": method.key(), "disableAuto": true}))
        }
        Write::Merge { method, admin, auto: None } => {
            ("pr:merge", json!({"cwd": cwd, "number": number, "method": method.key(), "admin": admin}))
        }
        Write::Ready { draft: false } => ("pr:ready", json!({"cwd": cwd, "number": number})),
        Write::Ready { draft: true } => ("pr:ready", json!({"cwd": cwd, "number": number, "draft": true})),
        Write::Reviewers { add, remove } => ("pr:request-reviewers", json!({"cwd": cwd, "number": number, "add": add, "remove": remove})),
        Write::Labels { add, remove } => {
            let add: Vec<&str> = add.iter().map(|label| label.name.as_str()).collect();
            ("pr:set-labels", json!({"cwd": cwd, "number": number, "add": add, "remove": remove}))
        }
        Write::Reply { thread, body } => ("pr:reply", json!({"cwd": cwd, "number": number, "threadId": thread, "body": body})),
        Write::Comment { path, side, line, start_line, body } => {
            let mut request = json!({
                "cwd": cwd, "number": number, "path": path, "line": line,
                "side": if *side == Side::Left { "LEFT" } else { "RIGHT" }, "body": body,
            });
            // Sent only for a range (`start < end`).
            if let Some(start) = start_line.filter(|start| start < line) {
                request["startLine"] = json!(start);
            }
            ("pr:comment", request)
        }
        Write::Resolve { thread, resolved } => ("pr:resolve-thread", json!({"cwd": cwd, "threadId": thread, "resolved": resolved})),
        Write::DeleteComment { id } => ("pr:delete-comment", json!({"cwd": cwd, "commentId": id})),
        Write::SubmitReview { event, body } => ("pr:submit-review", json!({"cwd": cwd, "number": number, "event": event.key(), "body": body})),
    }
}

/// `pull-requests:snapshot`'s answer (`PullRequestSnapshot`): each Worktree's branch PR by folder and each Chat-named
/// PR by folder and ref (`null`: looked, found none).
pub fn snapshot(value: &Value) -> PullRequestSnapshot {
    let worktrees = value["worktrees"]
        .as_object()
        .map(|map| map.iter().map(|(folder, pr)| (SharedString::from(folder.clone()), crate::panels::pull_request(pr))).collect())
        .unwrap_or_default();
    let chats = value["chats"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(folder, refs)| {
                    let refs: BTreeMap<SharedString, _> = refs
                        .as_object()
                        .map(|refs| refs.iter().map(|(r, pr)| (SharedString::from(r.clone()), crate::panels::pull_request(pr))).collect())
                        .unwrap_or_default();
                    (SharedString::from(folder.clone()), refs)
                })
                .collect()
        })
        .unwrap_or_default();
    PullRequestSnapshot { worktrees, chats, pending: value["pending"] == true }
}

// ---- The bridge ----

/// What the window holds of one Worktree folder's PRs.
#[derive(Default)]
struct Cache {
    details: HashMap<u32, Result<Read, String>>,
    patches: HashMap<(u32, String), DiffFileResult>,
    /// The head each PR's patches were read at.
    patched_at: HashMap<u32, String>,
    labels: Vec<RepoLabel>,
    candidates: Vec<String>,
    pickers_read: bool,
}

/// The panel's [`PrBridge`] on the daemon: it answers from what [`LivePr`] read, and sends writes to it.
pub struct LiveBridge {
    cache: Rc<RefCell<Cache>>,
    writes: UnboundedSender<(u32, Write)>,
}

impl PrBridge for LiveBridge {
    fn detail(&self, number: u32) -> Result<PullRequestDetail, String> {
        match self.cache.borrow().details.get(&number) {
            Some(Ok(read)) => Ok(read.detail.clone()),
            Some(Err(message)) => Err(message.clone()),
            None => Err("Loading the PR\u{2026}".to_owned()),
        }
    }

    fn write(&self, number: u32, write: &Write) -> Result<(), String> {
        self.writes.unbounded_send((number, write.clone())).map_err(|_| "This window closed its connection to Milagre.".to_owned())
    }

    fn reviewer_candidates(&self) -> Vec<String> {
        self.cache.borrow().candidates.clone()
    }

    fn repo_labels(&self) -> Vec<RepoLabel> {
        self.cache.borrow().labels.clone()
    }

    fn file_patch(&self, number: u32, file: &PrFile) -> Option<DiffFileResult> {
        self.cache.borrow().patches.get(&(number, file.path.clone())).cloned()
    }

    fn loading(&self, number: u32) -> bool {
        !self.cache.borrow().details.contains_key(&number)
    }

    fn deferred(&self) -> bool {
        true
    }
}

// ---- The panel's driver ----

#[derive(Clone, Debug, PartialEq)]
struct Shown {
    key: String,
    project: String,
    cwd: String,
    number: Option<u32>,
}

/// What one read brought back.
struct Fetched {
    detail: Result<Read, String>,
    patches: Option<(String, Vec<(String, DiffFileResult)>)>,
    pickers: Option<(Vec<RepoLabel>, Vec<String>)>,
}

/// Keeps the panel's PR tab on the daemon's answers. Owned by the controller.
pub struct LivePr {
    daemon: Arc<Daemon>,
    panel: Entity<Panel>,
    window: AnyWindowHandle,
    cache: Rc<RefCell<Cache>>,
    /// The folder the bridge serves.
    cwd: Option<String>,
    shown: Option<Shown>,
    reading: HashSet<(String, u32)>,
    writes: UnboundedSender<(u32, Write)>,
    /// Every request sent, as `method args` (tests and evidence), and the writes a read-only window refused.
    sent: Vec<(String, Value)>,
    refused: Vec<String>,
    errors: Vec<String>,
    reads: u64,
    _tasks: Vec<Task<()>>,
}

impl LivePr {
    pub fn new(daemon: Arc<Daemon>, panel: Entity<Panel>, window: AnyWindowHandle, cx: &mut Context<Self>) -> Self {
        let (writes, mut receiver) = unbounded::<(u32, Write)>();
        let run = cx.spawn(async move |this, cx| {
            while let Some((number, write)) = receiver.next().await {
                let Ok(Some(job)) = this.update(cx, |this, cx| this.start_write(number, write, cx)) else { continue };
                let result = job.await.unwrap_or_else(|_| Err("The write thread ended.".to_owned()));
                let _ = this.update(cx, |this, cx| this.finish_write(number, result, cx));
            }
        });
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let Ok(()) = this.update(cx, |this, cx| this.poll(cx)) else { return };
            }
        });
        Self {
            daemon,
            panel,
            window,
            cache: Rc::new(RefCell::new(Cache::default())),
            cwd: None,
            shown: None,
            reading: HashSet::new(),
            writes,
            sent: Vec::new(),
            refused: Vec::new(),
            errors: Vec::new(),
            reads: 0,
            _tasks: vec![run, poll],
        }
    }

    /// The panel's Chat `key` (in `project`, its Worktree folder `cwd`) and the PR it shows. A new folder gets a new
    /// bridge; a PR not read yet is read now.
    pub fn show(&mut self, key: &str, project: &str, cwd: &str, number: Option<u32>, cx: &mut Context<Self>) {
        let shown = Shown { key: key.to_owned(), project: project.to_owned(), cwd: cwd.to_owned(), number };
        if self.cwd.as_deref() != Some(cwd) {
            self.cwd = Some(cwd.to_owned());
            self.cache = Rc::new(RefCell::new(Cache::default()));
            let bridge = Rc::new(LiveBridge { cache: self.cache.clone(), writes: self.writes.clone() });
            let pr = self.panel.read(cx).pr().clone();
            pr.update(cx, |pr, cx| pr.set_bridge(bridge, cx));
        }
        let changed = self.shown.as_ref() != Some(&shown);
        self.shown = Some(shown);
        self.panel.update(cx, |panel, cx| panel.set_live_pr(key.to_owned().into(), number, 0, cx));
        if changed && let Some(number) = number {
            let known = self.cache.borrow().details.contains_key(&number);
            if !known {
                self.read(number, cx);
            }
        }
    }

    /// The Chat on screen has no Worktree or PR to show: the tab goes.
    pub fn hide(&mut self, key: &str, cx: &mut Context<Self>) {
        self.shown = None;
        self.panel.update(cx, |panel, cx| panel.set_live_pr(key.to_owned().into(), None, 0, cx));
    }

    /// The shown PR's detail, once read (the pills' review count).
    pub fn detail(&self, number: u32) -> Option<PullRequestDetail> {
        match self.cache.borrow().details.get(&number) {
            Some(Ok(read)) => Some(read.detail.clone()),
            _ => None,
        }
    }

    /// `pull-requests:changed {projectPath}`: the shown PR of that Project is read again.
    pub fn changed(&mut self, project: &str, cx: &mut Context<Self>) {
        if let Some(Shown { project: shown, number: Some(number), .. }) = self.shown.clone()
            && shown == project
        {
            self.read(number, cx);
        }
    }

    fn poll(&mut self, cx: &mut Context<Self>) {
        let active = self.window.update(cx, |_, window, _| window.is_window_active()).unwrap_or(false);
        if let (true, Some(Shown { number: Some(number), .. })) = (active, self.shown.clone()) {
            self.read(number, cx);
        }
    }

    /// Reads PR `number` of the shown folder: its detail, its patches when its head moved, the pickers' lists once.
    pub fn read(&mut self, number: u32, cx: &mut Context<Self>) {
        let Some(shown) = self.shown.clone() else { return };
        if !self.reading.insert((shown.cwd.clone(), number)) {
            return;
        }
        let (patched, pickers_read) = {
            let cache = self.cache.borrow();
            (cache.patched_at.get(&number).cloned(), cache.pickers_read)
        };
        let daemon = self.daemon.clone();
        let (project, cwd) = (shown.project.clone(), shown.cwd.clone());
        let mut sent = vec![("pr:detail".to_owned(), json!([{"cwd": cwd, "number": number}]))];
        let work = crate::usage::off_thread(move || {
            futures::executor::block_on(async {
                let mut asked = Vec::new();
                let answer = daemon.read(&project, "pr:detail", json!([{"cwd": cwd, "number": number}])).await;
                let detail = match answer {
                    Ok(answer) => detail_result(&answer),
                    Err(error) => Err(format!("Couldn't read this PR: {error:#}")),
                };
                let mut patches = None;
                if let Ok(read) = &detail
                    && !read.head.is_empty()
                    && patched.as_deref() != Some(read.head.as_str())
                {
                    let range = json!({"cwd": cwd, "base": read.base, "head": read.head});
                    asked.push(("pr:diff-files".to_owned(), json!([range])));
                    let files = daemon.read(&project, "pr:diff-files", json!([range])).await.ok();
                    let entries: Vec<(String, Option<String>)> = files
                        .as_ref()
                        .and_then(|files| files["files"].as_array())
                        .map(|files| {
                            files
                                .iter()
                                .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["oldPath"].as_str().map(str::to_owned))))
                                .take(PATCHES)
                                .collect()
                        })
                        .unwrap_or_default();
                    let calls: Vec<(&'static str, Value)> = entries
                        .iter()
                        .map(|(path, old)| {
                            let request = json!({"cwd": cwd, "base": read.base, "head": read.head, "path": path, "oldPath": old});
                            ("pr:diff-file", json!([request]))
                        })
                        .collect();
                    asked.extend(calls.iter().map(|(m, a)| ((*m).to_owned(), a.clone())));
                    let answers = if calls.is_empty() { Ok(Vec::new()) } else { daemon.read_many(&project, calls).await };
                    let read_patches = answers
                        .map(|answers| {
                            entries
                                .iter()
                                .zip(answers)
                                .filter_map(|((path, _), answer)| Some((path.clone(), crate::git::diff_file(&answer.ok()?))))
                                .collect()
                        })
                        .unwrap_or_default();
                    patches = Some((read.head.clone(), read_patches));
                }
                let pickers = if detail.is_ok() && !pickers_read {
                    asked.push(("pr:labels".to_owned(), json!([{"cwd": cwd}])));
                    asked.push(("pr:reviewer-candidates".to_owned(), json!([{"cwd": cwd}])));
                    let labels = daemon.read(&project, "pr:labels", json!([{"cwd": cwd}])).await.unwrap_or_default();
                    let logins = daemon.read(&project, "pr:reviewer-candidates", json!([{"cwd": cwd}])).await.unwrap_or_default();
                    Some((
                        list(&labels, "labels", |l| {
                            Some(RepoLabel { name: l["name"].as_str()?.to_owned(), color: text(l, "color"), description: text(l, "description") })
                        }),
                        list(&logins, "logins", |l| l.as_str().map(str::to_owned)),
                    ))
                } else {
                    None
                };
                (Fetched { detail, patches, pickers }, asked)
            })
        });
        let cache = self.cache.clone();
        cx.spawn(async move |this, cx| {
            let Ok((fetched, asked)) = work.await else { return };
            let _ = this.update(cx, |this, cx| {
                this.reading.remove(&(shown.cwd.clone(), number));
                this.reads += 1;
                sent.extend(asked);
                this.sent.extend(sent);
                // Another folder's answer arrived after a switch: its cache is gone with it.
                if !Rc::ptr_eq(&cache, &this.cache) {
                    return;
                }
                {
                    let mut cache = cache.borrow_mut();
                    if let Err(message) = &fetched.detail {
                        this.errors.push(format!("pr:detail #{number}: {message}"));
                    }
                    // A failed read keeps an earlier good one.
                    if fetched.detail.is_ok() || !matches!(cache.details.get(&number), Some(Ok(_))) {
                        cache.details.insert(number, fetched.detail);
                    }
                    if let Some((head, patches)) = fetched.patches {
                        cache.patches.retain(|(n, _), _| *n != number);
                        cache.patches.extend(patches.into_iter().map(|(path, patch)| ((number, path), patch)));
                        cache.patched_at.insert(number, head);
                    }
                    if let Some((labels, candidates)) = fetched.pickers {
                        cache.labels = labels;
                        cache.candidates = candidates;
                        cache.pickers_read = true;
                    }
                }
                let pr = this.panel.read(cx).pr().clone();
                pr.update(cx, |pr, cx| pr.reload(cx));
                cx.notify();
            });
        })
        .detach();
    }

    fn start_write(
        &mut self,
        number: u32,
        write: Write,
        cx: &mut Context<Self>,
    ) -> Option<futures::channel::oneshot::Receiver<Result<(), String>>> {
        let Some(shown) = self.shown.clone() else {
            let pr = self.panel.read(cx).pr().clone();
            pr.update(cx, |pr, cx| pr.write_done(number, Err("This PR is no longer shown.".into()), cx));
            return None;
        };
        let (method, request) = request(&shown.cwd, number, &write);
        if self.daemon.read_only() {
            self.refused.push(format!("{method} #{number}"));
            eprintln!("live: read-only, not sent: {method} #{number}");
            let pr = self.panel.read(cx).pr().clone();
            pr.update(cx, |pr, cx| pr.write_done(number, Err("Read-only: nothing is written to Milagre's daemon in this window.".into()), cx));
            return None;
        }
        self.sent.push((method.to_owned(), json!([request.clone()])));
        let (daemon, project) = (self.daemon.clone(), shown.project.clone());
        Some(crate::usage::off_thread(move || {
            futures::executor::block_on(async {
                let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                let answer = writer.call(method, json!([request])).await.map_err(|e| format!("{e:#}"))?;
                drop(writer);
                write_result(&answer)
            })
        }))
    }

    fn finish_write(&mut self, number: u32, result: Result<(), String>, cx: &mut Context<Self>) {
        if let Err(message) = &result {
            self.errors.push(format!("PR #{number}: {message}"));
        }
        let pr = self.panel.read(cx).pr().clone();
        pr.update(cx, |pr, cx| pr.write_done(number, result, cx));
        // Electron reads the PR after every write.
        self.read(number, cx);
    }

    /// Requests sent, oldest first (tests).
    pub fn sent(&self) -> &[(String, Value)] {
        &self.sent
    }

    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    /// Finished reads.
    pub fn reads(&self) -> u64 {
        self.reads
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_gpui_spike::workspace::panel::pr::model::ReviewEvent;

    pub fn sample(number: u32) -> Value {
        json!({
            "number": number, "url": format!("https://github.com/acme/widgets/pull/{number}"), "title": "Make widgets faster",
            "body": "<p>Speeds up the widget loop.</p>", "state": "OPEN", "isDraft": false, "author": "someone",
            "createdAt": "2026-11-10T10:00:00Z", "updatedAt": "2026-11-12T10:00:00Z",
            "baseRefName": "main", "headRefName": "faster", "headRefOid": "bbb", "baseRefOid": "aaa",
            "additions": 12, "deletions": 3, "changedFiles": 2, "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
            "autoMerge": null, "viewerCanMergeAsAdmin": true, "viewerIsAuthor": true,
            "checks": [{"name": "test", "workflow": "CI", "outcome": "pass", "url": "https://example.com/1"}, {"name": "lint", "outcome": "running"}],
            "reviewers": [{"login": "reviewer", "state": "APPROVED"}, {"login": "acme/team", "state": "REQUESTED", "team": true}],
            "labels": [{"name": "perf", "color": "00ff00"}],
            "commits": [{"oid": "bbb", "headline": "Faster"}],
            "files": [{"path": "src/a.rs", "additions": 10, "deletions": 2, "status": "modified"}, {"path": "src/b.rs", "additions": 2, "deletions": 1, "status": "added"}],
            "threads": [
                {"id": "T1", "path": "src/a.rs", "line": 4, "side": "RIGHT", "resolved": false, "outdated": false,
                 "comments": [{"id": "C1", "author": "reviewer", "body": "Why?", "createdAt": "2026-11-11T10:00:00Z"}]},
                {"id": "T2", "path": "src/a.rs", "line": null, "side": "LEFT", "resolved": true, "outdated": true,
                 "comments": [{"id": "C2", "author": "reviewer", "body": "Old", "createdAt": "2026-11-11T10:00:00Z"}]}
            ],
            "comments": [{"id": "C3", "author": "someone", "body": "Ready", "createdAt": "2026-11-11T11:00:00Z"}],
            "pendingReview": {"id": "R1", "count": 2}
        })
    }

    #[test]
    fn a_detail_decodes_as_the_panel_reads_it() {
        let read = detail_result(&json!({"ok": true, "pr": sample(21)})).expect("a PR");
        assert_eq!((read.base.as_str(), read.head.as_str()), ("aaa", "bbb"));
        let pr = read.detail;
        assert_eq!((pr.number, pr.state, pr.is_draft, pr.merge_state_status.as_str()), (21, PullState::Open, false, "CLEAN"));
        assert_eq!(pr.review_decision, Some(ReviewDecision::Approved));
        assert_eq!(pr.checks.len(), 2);
        assert_eq!(pr.checks[1].outcome, Outcome::Running);
        assert!(pr.reviewers[1].team);
        assert_eq!(pr.files[1].status, DiffStatus::Added);
        assert_eq!(pr.threads[1].line, None);
        assert_eq!(pr.threads[1].side, Side::Left);
        assert_eq!(pr.pending_review, Some(2));
        assert!(pr.created_at > 0);
        assert_eq!(milagre_gpui_spike::workspace::panel::pr::model::open_threads(&pr).len(), 1);
        assert_eq!(detail_result(&json!({"ok": false, "message": "gh is signed out"})), Err("gh is signed out".into()));
    }

    #[test]
    fn writes_are_sent_as_electron_sends_them() {
        let m = MergeMethod::Squash;
        assert_eq!(
            request("/w", 7, &Write::Merge { method: m, admin: false, auto: None }),
            ("pr:merge", json!({"cwd": "/w", "number": 7, "method": "squash", "admin": false}))
        );
        assert_eq!(request("/w", 7, &Write::Merge { method: m, admin: true, auto: None }).1["admin"], json!(true));
        assert_eq!(request("/w", 7, &Write::Merge { method: m, admin: false, auto: Some(true) }).1["auto"], json!(true));
        assert_eq!(request("/w", 7, &Write::Merge { method: m, admin: false, auto: Some(false) }).1["disableAuto"], json!(true));
        assert_eq!(request("/w", 7, &Write::Ready { draft: false }), ("pr:ready", json!({"cwd": "/w", "number": 7})));
        assert_eq!(request("/w", 7, &Write::Ready { draft: true }).1["draft"], json!(true));
        let comment = Write::Comment { path: "a".into(), side: Side::Right, line: 5, start_line: Some(5), body: "x".into() };
        assert!(request("/w", 7, &comment).1.get("startLine").is_none(), "a one-line comment sends no startLine");
        let range = Write::Comment { path: "a".into(), side: Side::Left, line: 5, start_line: Some(3), body: "x".into() };
        assert_eq!(request("/w", 7, &range).1["startLine"], json!(3));
        assert_eq!(request("/w", 7, &range).1["side"], json!("LEFT"));
        assert_eq!(request("/w", 7, &Write::Reply { thread: "T".into(), body: "b".into() }).1["threadId"], json!("T"));
        assert_eq!(request("/w", 7, &Write::Resolve { thread: "T".into(), resolved: true }).0, "pr:resolve-thread");
        assert_eq!(request("/w", 7, &Write::DeleteComment { id: "C".into() }).1, json!({"cwd": "/w", "commentId": "C"}));
        assert_eq!(request("/w", 7, &Write::SubmitReview { event: ReviewEvent::Approve, body: String::new() }).1["event"], json!("APPROVE"));
        let labels = Write::Labels { add: vec![Label { name: "perf".into(), color: "0".into() }], remove: vec!["old".into()] };
        assert_eq!(request("/w", 7, &labels), ("pr:set-labels", json!({"cwd": "/w", "number": 7, "add": ["perf"], "remove": ["old"]})));
        assert_eq!(write_result(&json!({"ok": false, "message": "Merge blocked"})), Err("Merge blocked".into()));
    }

    #[test]
    fn the_snapshot_decodes_for_the_sidebar() {
        let snapshot = snapshot(&json!({
            "worktrees": {"/w": {"number": 21, "title": "T", "url": "https://github.com/a/b/pull/21", "state": "OPEN", "readyToMerge": true}, "/x": null},
            "chats": {"/w": {"https://github.com/a/b/pull/22": null}},
            "pending": true
        }));
        assert_eq!(snapshot.worktrees["/w"].as_ref().and_then(|pr| pr.number), Some(21));
        assert!(snapshot.worktrees["/x"].is_none());
        assert!(snapshot.chats["/w"].contains_key("https://github.com/a/b/pull/22"));
        assert!(snapshot.pending);
    }
}
