//! The PR panel's seam to GitHub: what the desktop's `bridge.pr` answers (`pr:detail`, `pr:merge`, `pr:ready`,
//! `pr:labels`, `pr:request-reviewers`, `pr:reply`, `pr:resolve-thread`, `pr:submit-review`) as a trait the panel
//! reads and writes through. [`super::fixture::FixtureBridge`] implements it now; a daemon-backed one replaces it
//! (the calls are synchronous here because fixtures answer at once). A daemon-backed bridge reads ahead and answers
//! from what it holds: [`PrBridge::loading`] while a read is on its way, then `PrView::reload`; its writes are
//! [`PrBridge::deferred`], finished by `PrView::write_done`.
//!
//! A write is a [`Write`]; [`apply`] is the change it makes to a detail, which the view shows at once (the desktop's
//! optimistic `write(label, run, optimistic)`) and keeps while the bridge answers.

use super::model::{
    Comment, Label, MergeMethod, PrFile, PullRequestDetail, PullState, RepoLabel, ReviewEvent, Reviewer, ReviewerState, Side, Thread,
    now_ms,
};
use crate::logic::diff::git::DiffFileResult;

/// One write to GitHub.
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    /// `pr:merge`: now, as an admin past the rules, or turning auto-merge on or off.
    Merge {
        method: MergeMethod,
        admin: bool,
        auto: Option<bool>,
    },
    /// `pr:ready`: out of draft, or back into it.
    Ready {
        draft: bool,
    },
    Reviewers {
        add: Vec<String>,
        remove: Vec<String>,
    },
    Labels {
        add: Vec<Label>,
        remove: Vec<String>,
    },
    Reply {
        thread: String,
        body: String,
    },
    /// `pr:comment`: a new thread on lines of a file (`start_line` for a range), in the viewer's pending review.
    Comment {
        path: String,
        side: Side,
        line: u32,
        start_line: Option<u32>,
        body: String,
    },
    Resolve {
        thread: String,
        resolved: bool,
    },
    DeleteComment {
        id: String,
    },
    SubmitReview {
        event: ReviewEvent,
        body: String,
    },
}

pub trait PrBridge {
    /// `pr:detail [{ cwd, number }]`.
    fn detail(&self, number: u32) -> Result<PullRequestDetail, String>;
    /// Runs a write; the message says why it failed (signed out of gh, no permission, merge blocked).
    fn write(&self, number: u32, write: &Write) -> Result<(), String>;
    /// `pr:reviewer-candidates`: the logins a reviewer can be requested from.
    fn reviewer_candidates(&self) -> Vec<String>;
    /// `pr:labels`: the repository's labels.
    fn repo_labels(&self) -> Vec<RepoLabel>;
    /// `pr:diff-file`: the PR's patch for a file.
    fn file_patch(&self, number: u32, file: &PrFile) -> Option<DiffFileResult>;
    /// The PR is still being read (a daemon's answer is on its way): the panel shows "Loading the PR…" instead of
    /// asking [`PrBridge::detail`]. The fixture answers at once.
    fn loading(&self, _number: u32) -> bool {
        false
    }
    /// Writes answer later (a daemon): [`PrBridge::write`] only starts one and its `Ok` means "sent"; the data layer
    /// then calls `PrView::write_done` with the answer, and the view keeps its change (and the busy label) until then.
    fn deferred(&self) -> bool {
        false
    }
}

/// What `write` does to a detail, the way GitHub would show it afterwards.
pub fn apply(pr: &PullRequestDetail, write: &Write) -> PullRequestDetail {
    let mut next = pr.clone();
    match write {
        Write::Merge { auto: Some(true), method, .. } => next.auto_merge = Some(*method),
        Write::Merge { auto: Some(false), .. } => next.auto_merge = None,
        Write::Merge { auto: None, .. } => {
            next.state = PullState::Merged;
            next.auto_merge = None;
            next.updated_at = now_ms();
        }
        Write::Ready { draft } => {
            next.is_draft = *draft;
            if !draft && next.merge_state_status == "DRAFT" {
                next.merge_state_status = "CLEAN".to_string();
            }
        }
        Write::Reviewers { add, remove } => {
            next.reviewers.retain(|reviewer| !remove.contains(&reviewer.login));
            for login in add {
                if !next.reviewers.iter().any(|reviewer| &reviewer.login == login) {
                    next.reviewers.push(Reviewer::new(login, ReviewerState::Requested));
                }
            }
        }
        Write::Labels { add, remove } => {
            next.labels.retain(|label| !remove.contains(&label.name));
            for label in add {
                if !next.labels.iter().any(|entry| entry.name == label.name) {
                    next.labels.push(label.clone());
                }
            }
        }
        Write::Reply { thread, body } => {
            if let Some(thread) = next.threads.iter_mut().find(|entry| &entry.id == thread) {
                let id = format!("{}-reply-{}", thread.id, thread.comments.len() + 1);
                thread.comments.push(Comment { id, author: next.author.clone(), body: body.clone(), created_at: now_ms(), pending: true });
                next.pending_review = Some(next.pending_review.unwrap_or(0) + 1);
            }
        }
        Write::Comment { path, side, line, body, .. } => {
            let id = format!("pending-{}", next.threads.len() + 1);
            next.threads.push(Thread {
                id: id.clone(),
                path: path.clone(),
                line: Some(*line),
                side: *side,
                resolved: false,
                outdated: false,
                comments: vec![Comment {
                    id: format!("{id}-1"),
                    author: next.author.clone(),
                    body: body.clone(),
                    created_at: now_ms(),
                    pending: true,
                }],
            });
            next.pending_review = Some(next.pending_review.unwrap_or(0) + 1);
        }
        Write::Resolve { thread, resolved } => {
            if let Some(thread) = next.threads.iter_mut().find(|entry| &entry.id == thread) {
                thread.resolved = *resolved;
            }
        }
        Write::DeleteComment { id } => {
            let before: usize = next.threads.iter().map(|t| t.comments.len()).sum();
            for thread in &mut next.threads {
                thread.comments.retain(|comment| &comment.id != id);
            }
            next.threads.retain(|thread| !thread.comments.is_empty());
            let removed = before - next.threads.iter().map(|t| t.comments.len()).sum::<usize>();
            next.pending_review = next.pending_review.map(|n| n.saturating_sub(removed as u32)).filter(|n| *n > 0);
        }
        Write::SubmitReview { event, .. } => {
            for thread in &mut next.threads {
                for comment in &mut thread.comments {
                    comment.pending = false;
                }
            }
            next.pending_review = None;
            next.review_decision = match event {
                ReviewEvent::Approve => Some(super::model::ReviewDecision::Approved),
                ReviewEvent::RequestChanges => Some(super::model::ReviewDecision::ChangesRequested),
                ReviewEvent::Comment => next.review_decision,
            };
        }
    }
    next
}
