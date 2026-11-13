//! Pull requests: `PullRequest` and `PullRequestSnapshot` in `packages/shared/src/model.ts`, what
//! `pull-requests:snapshot [projectPath]` answers. The PR type is `logic::prs`'s (`PullRequestStatus`), which already
//! has every field `PullRequest` sends; the presentation rules (blockers, tone, icon, row order) live there too.

use std::collections::BTreeMap;

use gpui::SharedString;

pub use crate::logic::prs::blockers::{Checks, PrState, PullRequestStatus as PullRequest};

/// `PullRequestSnapshot`: a Project's PRs as the host's poll last found them: each Worktree's branch PR by folder,
/// and each Chat-named PR (`ChatSummary.pullRequests`) by folder and ref. `None` is "looked, found none".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PullRequestSnapshot {
    pub worktrees: BTreeMap<SharedString, Option<PullRequest>>,
    pub chats: BTreeMap<SharedString, BTreeMap<SharedString, Option<PullRequest>>>,
    /// Some were never read yet; they come with the next `pull-requests:changed`.
    pub pending: bool,
}

impl PullRequestSnapshot {
    /// The Chat's PRs (`chatPullRequests`): the ones its summary names, in its order (the snapshot's read of each ref
    /// in `folder`, or just its number from the URL when the host has not read it yet), with the Worktree branch's PR
    /// included once (the fresher copy of a PR the Chat named too).
    pub fn chat_pull_requests(&self, folder: &str, refs: &[SharedString]) -> Vec<PullRequest> {
        let read = self.chats.get(folder);
        let branch = self.worktrees.get(folder).cloned().flatten();
        let mut prs: Vec<PullRequest> = Vec::new();
        let named = refs.iter().filter_map(|reference| match read.and_then(|prs| prs.get(reference)) {
            Some(found) => found.clone(),
            None => pull_request_number(reference).map(|number| PullRequest {
                number: Some(number),
                url: reference.to_string(),
                ..PullRequest::default()
            }),
        });
        for pr in named.chain(branch.clone()) {
            let pr = match &branch {
                Some(branch) if !branch.url.is_empty() && branch.url == pr.url => branch.clone(),
                _ => pr,
            };
            if !prs.iter().any(|other| other.url == pr.url && (!pr.url.is_empty() || other.number == pr.number)) {
                prs.push(pr);
            }
        }
        prs
    }
}

/// The number at the end of a PR's URL (`https://github.com/o/r/pull/1015` is 1015).
pub fn pull_request_number(url: &str) -> Option<u32> {
    let (_, tail) = url.trim_end_matches('/').rsplit_once("/pull/")?;
    tail.split(['?', '#', '/']).next()?.parse().ok()
}
