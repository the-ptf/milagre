//! After `packages/shared/src/pr-blockers.ts` (and the colour and glyph tables of `lib/pr-look.ts`): which
//! blockers a PR has, the badge every PR shows, the row order, the composer action and its dismissals.

use super::action::pr_action;

/// What can stop an open PR from merging (`PullRequestBlocker`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Blocker {
    Conflicts,
    ChangesRequested,
    ChecksFailed,
    Behind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockerTone {
    Red,
    Orange,
}

impl Blocker {
    /// Most urgent first: conflicts before review, failed CI before an outdated branch.
    pub const ORDER: [Blocker; 4] = [Blocker::Conflicts, Blocker::ChangesRequested, Blocker::ChecksFailed, Blocker::Behind];

    /// The wire name (`"checks-failed"`).
    pub fn key(self) -> &'static str {
        match self {
            Blocker::Conflicts => "conflicts",
            Blocker::ChangesRequested => "changes-requested",
            Blocker::ChecksFailed => "checks-failed",
            Blocker::Behind => "behind",
        }
    }

    pub fn from_key(key: &str) -> Option<Blocker> {
        Blocker::ORDER.into_iter().find(|blocker| blocker.key() == key)
    }

    /// `BLOCKERS[b].short`.
    pub fn short(self) -> &'static str {
        match self {
            Blocker::Conflicts => "Conflicts",
            Blocker::ChangesRequested => "Needs changes",
            Blocker::ChecksFailed => "CI failed",
            Blocker::Behind => "Out of date",
        }
    }

    /// `BLOCKERS[b].long`.
    pub fn long(self) -> &'static str {
        match self {
            Blocker::Conflicts => "Merge conflicts",
            Blocker::ChangesRequested => "Changes requested",
            Blocker::ChecksFailed => "CI checks failed",
            Blocker::Behind => "Out of date with the base branch",
        }
    }

    /// `BLOCKERS[b].action`: the pill's label.
    pub fn action_label(self) -> &'static str {
        pr_action(self).label
    }

    pub fn tone(self) -> BlockerTone {
        match self {
            Blocker::Behind => BlockerTone::Orange,
            _ => BlockerTone::Red,
        }
    }
}

/// A PR's state. `Other` stands for a state string the host sent that is none of the three: it is open as far as
/// the badge goes, and it blocks nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PrState {
    #[default]
    Open,
    Merged,
    Closed,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checks {
    Running,
    Failed,
}

/// The PR fields the logic reads (`BlockerStatus` plus `readyToMerge`, `isDraft`, `title`). Absent booleans are
/// `false`, as `Boolean(undefined)` is; `conflict_status_known` keeps its three states.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PullRequestStatus {
    pub number: Option<u32>,
    pub title: String,
    pub url: String,
    pub state: PrState,
    pub has_conflicts: bool,
    pub conflict_status_known: Option<bool>,
    pub is_behind: bool,
    pub changes_requested: bool,
    pub checks: Option<Checks>,
    pub ready_to_merge: bool,
    pub is_draft: bool,
}

fn blocks(pr: &PullRequestStatus, blocker: Blocker) -> bool {
    if pr.state != PrState::Open {
        return false;
    }
    match blocker {
        Blocker::Conflicts => pr.has_conflicts,
        Blocker::Behind => pr.is_behind,
        Blocker::ChecksFailed => pr.checks == Some(Checks::Failed),
        Blocker::ChangesRequested => pr.changes_requested,
    }
}

/// A false flag only proves the blocker is gone when GitHub actually computed the merge state.
fn clears(pr: &PullRequestStatus, blocker: Blocker) -> bool {
    if pr.state != PrState::Open {
        return true;
    }
    if blocks(pr, blocker) {
        return false;
    }
    matches!(blocker, Blocker::ChangesRequested | Blocker::ChecksFailed) || pr.conflict_status_known != Some(false)
}

/// `pullRequestBlockers`: the PR's blockers, most urgent first.
pub fn pull_request_blockers(pr: Option<&PullRequestStatus>) -> Vec<Blocker> {
    match pr {
        Some(pr) => Blocker::ORDER.into_iter().filter(|blocker| blocks(pr, *blocker)).collect(),
        None => Vec::new(),
    }
}

/// A badge colour (`PullRequestTone`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrTone {
    Ink3,
    Green,
    Orange,
    Red,
    Purple,
}

impl PrTone {
    /// `PR_TONE[tone].icon`: the palette key the glyph is drawn in.
    pub fn icon_key(self) -> &'static str {
        match self {
            PrTone::Ink3 => "ink3",
            PrTone::Green => "green",
            PrTone::Orange => "orange",
            PrTone::Red => "red",
            PrTone::Purple => "purple",
        }
    }

    /// `PR_TONE[tone].label`: the palette key the label is drawn in (the -ink shade).
    pub fn label_key(self) -> &'static str {
        match self {
            PrTone::Ink3 => "ink3",
            PrTone::Green => "greenInk",
            PrTone::Orange => "orangeInk",
            PrTone::Red => "redInk",
            PrTone::Purple => "purpleInk",
        }
    }
}

/// The glyph of a PR badge (`PR_ICONS` in `lib/pr-look.ts`): the Hugeicons the desktop draws for each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrIcon {
    Merged,
    Closed,
    Draft,
    Ready,
    Checking,
    Open,
}

impl PrIcon {
    /// The name `presentation.icon` carries in TypeScript.
    pub fn key(self) -> &'static str {
        match self {
            PrIcon::Merged => "merged",
            PrIcon::Closed => "closed",
            PrIcon::Draft => "draft",
            PrIcon::Ready => "ready",
            PrIcon::Checking => "checking",
            PrIcon::Open => "open",
        }
    }

    /// The Hugeicons export `pr-look.ts` imports for it.
    pub fn hugeicon(self) -> &'static str {
        match self {
            PrIcon::Merged => "GitMergeIcon",
            PrIcon::Closed => "GitPullRequestClosedIcon",
            PrIcon::Draft => "GitPullRequestDraftIcon",
            PrIcon::Ready => "Tick02Icon",
            PrIcon::Checking => "CircleDotIcon",
            PrIcon::Open => "GitPullRequestIcon",
        }
    }
}

/// What `pullRequestPresentation` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct PrPresentation {
    pub blocker: Option<Blocker>,
    pub merged: bool,
    pub closed: bool,
    pub draft: bool,
    pub ready: bool,
    pub checking: bool,
    pub tone: PrTone,
    pub icon: PrIcon,
    pub label: &'static str,
    /// The tooltip and spoken words: "Draft pull request #12", "CI checks failed · Pull request #12".
    pub description: String,
    /// What a screen reader says after "Open": "merged pull request #12", "pull request #12, ci failed".
    pub spoken: String,
}

/// `pullRequestPresentation`: the same badge status, colour and label everywhere a PR shows.
pub fn pull_request_presentation(pr: &PullRequestStatus) -> PrPresentation {
    let blocker = pull_request_blockers(Some(pr)).first().copied();
    let merged = pr.state == PrState::Merged;
    let closed = pr.state == PrState::Closed;
    let open = !merged && !closed;
    let draft = open && blocker.is_none() && pr.is_draft;
    let ready = open && blocker.is_none() && !draft && pr.ready_to_merge;
    let checking = open && blocker.is_none() && !draft && !ready && pr.checks == Some(Checks::Running);
    let tone = if merged {
        PrTone::Purple
    } else if closed || draft {
        PrTone::Ink3
    } else if let Some(blocker) = blocker {
        match blocker.tone() {
            BlockerTone::Red => PrTone::Red,
            BlockerTone::Orange => PrTone::Orange,
        }
    } else if checking {
        PrTone::Orange
    } else {
        PrTone::Green
    };
    let icon = if merged {
        PrIcon::Merged
    } else if closed {
        PrIcon::Closed
    } else if draft {
        PrIcon::Draft
    } else if ready {
        PrIcon::Ready
    } else if checking {
        PrIcon::Checking
    } else {
        PrIcon::Open
    };
    let label = if merged {
        "Merged"
    } else if closed {
        "Closed"
    } else if let Some(blocker) = blocker {
        blocker.short()
    } else if draft {
        "Draft"
    } else if ready {
        "Ready"
    } else if checking {
        "CI running"
    } else {
        ""
    };
    let number = pr.number.map(|n| n.to_string()).unwrap_or_default();
    let description = if merged {
        format!("Merged pull request #{number}")
    } else if closed {
        format!("Closed pull request #{number}")
    } else if let Some(blocker) = blocker {
        format!("{} · Pull request #{number}", blocker.long())
    } else if draft {
        format!("Draft pull request #{number}")
    } else if ready {
        format!("Ready to merge · Pull request #{number}")
    } else if checking {
        format!("CI checks running · Pull request #{number}")
    } else {
        format!("Open pull request #{number}")
    };
    let prefix = if merged {
        "merged "
    } else if closed {
        "closed "
    } else if draft {
        "draft "
    } else {
        ""
    };
    let suffix = if let Some(blocker) = blocker {
        format!(", {}", blocker.short().to_lowercase())
    } else if ready {
        ", ready to merge".to_string()
    } else if checking {
        ", CI running".to_string()
    } else {
        String::new()
    };
    let spoken = format!("{prefix}pull request #{number}{suffix}");
    PrPresentation { blocker, merged, closed, draft, ready, checking, tone, icon, label, description, spoken }
}

/// The pill after a PR's number in its header (`pullRequestStatePill`); fill and ink are palette keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatePill {
    pub label: &'static str,
    pub fill: &'static str,
    pub ink: &'static str,
}

/// `pullRequestStatePill`: Draft, Merged or Closed; an open PR ready for review has none.
pub fn pull_request_state_pill(state: PrState, is_draft: bool) -> Option<StatePill> {
    match state {
        PrState::Merged => Some(StatePill { label: "Merged", fill: "purpleTint", ink: "purpleInk" }),
        PrState::Closed => Some(StatePill { label: "Closed", fill: "redTint", ink: "redInk" }),
        _ if is_draft => Some(StatePill { label: "Draft", fill: "hover", ink: "ink2" }),
        _ => None,
    }
}

/// The auto-merge button's words once it is armed.
pub const AUTO_MERGE_LABEL: &str = "Merges when ready";

/// `rowPullRequests`: blocked PRs first, then other open ones, then merged, then closed; creation order within each.
pub fn row_pull_requests(prs: &[PullRequestStatus]) -> Vec<PullRequestStatus> {
    let rank = |pr: &PullRequestStatus| match pr.state {
        PrState::Closed => 3,
        PrState::Merged => 2,
        _ if !pull_request_blockers(Some(pr)).is_empty() => 0,
        _ => 1,
    };
    let mut rows: Vec<(usize, &PullRequestStatus)> = prs.iter().enumerate().collect();
    rows.sort_by_key(|(index, pr)| (rank(pr), *index));
    rows.into_iter().map(|(_, pr)| pr.clone()).collect()
}

/// The composer's PR action (`pullRequestAction`): the PR and its first blocker the agent isn't already fixing.
pub fn pull_request_action(prs: &[PullRequestStatus], dismissed: &[String]) -> Option<(PullRequestStatus, Blocker)> {
    for pr in row_pull_requests(prs) {
        let blocker = pull_request_blockers(Some(&pr)).into_iter().find(|candidate| !is_blocker_dismissed(dismissed, *candidate, &pr));
        if let Some(blocker) = blocker {
            return Some((pr, blocker));
        }
    }
    None
}

fn dismissal_key(blocker: Blocker, url: &str) -> String {
    if blocker == Blocker::Conflicts { url.to_string() } else { format!("{}:{url}", blocker.key()) }
}

/// `isBlockerDismissed`.
pub fn is_blocker_dismissed(dismissed: &[String], blocker: Blocker, pr: &PullRequestStatus) -> bool {
    let key = dismissal_key(blocker, &pr.url);
    dismissed.contains(&key)
}

/// `updateBlockerDismissals`: once the agent is asked to fix a blocker its action stays hidden, and comes back only
/// after GitHub confirms the blocker cleared and it then recurs. `pr` is `None` for a failed lookup.
pub fn update_blocker_dismissals(dismissed: &[String], pr: Option<&PullRequestStatus>, clicked: Option<Blocker>) -> Vec<String> {
    let Some(pr) = pr else { return dismissed.to_vec() };
    if let Some(clicked) = clicked {
        let entry = dismissal_key(clicked, &pr.url);
        if blocks(pr, clicked) && !dismissed.contains(&entry) {
            let mut next = dismissed.to_vec();
            next.push(entry);
            return next;
        }
        return dismissed.to_vec();
    }
    let cleared: Vec<String> = Blocker::ORDER.into_iter().filter(|blocker| clears(pr, *blocker)).map(|blocker| dismissal_key(blocker, &pr.url)).collect();
    if cleared.iter().any(|entry| dismissed.contains(entry)) {
        dismissed.iter().filter(|entry| !cleared.contains(entry)).cloned().collect()
    } else {
        dismissed.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u32) -> PullRequestStatus {
        PullRequestStatus { number: Some(number), url: format!("https://github.com/o/r/pull/{number}"), ..Default::default() }
    }

    #[test]
    fn blockers_come_most_urgent_first_and_only_on_open_prs() {
        let mut all = pr(1);
        all.has_conflicts = true;
        all.changes_requested = true;
        all.checks = Some(Checks::Failed);
        all.is_behind = true;
        assert_eq!(pull_request_blockers(Some(&all)), Blocker::ORDER.to_vec());
        all.state = PrState::Merged;
        assert!(pull_request_blockers(Some(&all)).is_empty());
        assert!(pull_request_blockers(None).is_empty());
        let mut running = pr(2);
        running.checks = Some(Checks::Running);
        assert!(pull_request_blockers(Some(&running)).is_empty());
    }

    #[test]
    fn the_badge_is_the_same_everywhere() {
        let merged = pull_request_presentation(&PullRequestStatus { state: PrState::Merged, ..pr(12) });
        assert_eq!((merged.tone, merged.icon, merged.label), (PrTone::Purple, PrIcon::Merged, "Merged"));
        assert_eq!(merged.description, "Merged pull request #12");
        assert_eq!(merged.spoken, "merged pull request #12");
        let closed = pull_request_presentation(&PullRequestStatus { state: PrState::Closed, ..pr(12) });
        assert_eq!((closed.tone, closed.label), (PrTone::Ink3, "Closed"));
        assert_eq!(closed.spoken, "closed pull request #12");

        let failed = pull_request_presentation(&PullRequestStatus { checks: Some(Checks::Failed), is_draft: true, ..pr(12) });
        assert_eq!((failed.tone, failed.icon, failed.label), (PrTone::Red, PrIcon::Open, "CI failed"));
        assert!(!failed.draft, "a blocker beats draft");
        assert_eq!(failed.description, "CI checks failed · Pull request #12");
        assert_eq!(failed.spoken, "pull request #12, ci failed");

        let behind = pull_request_presentation(&PullRequestStatus { is_behind: true, ..pr(12) });
        assert_eq!((behind.tone, behind.label), (PrTone::Orange, "Out of date"));

        let draft = pull_request_presentation(&PullRequestStatus { is_draft: true, ready_to_merge: true, ..pr(12) });
        assert_eq!((draft.tone, draft.icon, draft.label), (PrTone::Ink3, PrIcon::Draft, "Draft"));
        assert_eq!(draft.description, "Draft pull request #12");
        assert_eq!(draft.spoken, "draft pull request #12");

        let ready = pull_request_presentation(&PullRequestStatus { ready_to_merge: true, checks: Some(Checks::Running), ..pr(12) });
        assert_eq!((ready.tone, ready.icon, ready.label), (PrTone::Green, PrIcon::Ready, "Ready"));
        assert_eq!(ready.description, "Ready to merge · Pull request #12");
        assert_eq!(ready.spoken, "pull request #12, ready to merge");

        let running = pull_request_presentation(&PullRequestStatus { checks: Some(Checks::Running), ..pr(12) });
        assert_eq!((running.tone, running.icon, running.label), (PrTone::Orange, PrIcon::Checking, "CI running"));
        assert_eq!(running.description, "CI checks running · Pull request #12");
        assert_eq!(running.spoken, "pull request #12, CI running");

        let plain = pull_request_presentation(&pr(12));
        assert_eq!((plain.tone, plain.icon, plain.label), (PrTone::Green, PrIcon::Open, ""));
        assert_eq!(plain.description, "Open pull request #12");
        let numberless = pull_request_presentation(&PullRequestStatus::default());
        assert_eq!(numberless.description, "Open pull request #");
    }

    #[test]
    fn tone_keys_match_the_palette_table() {
        assert_eq!((PrTone::Green.icon_key(), PrTone::Green.label_key()), ("green", "greenInk"));
        assert_eq!((PrTone::Ink3.icon_key(), PrTone::Ink3.label_key()), ("ink3", "ink3"));
        assert_eq!(PrTone::Purple.label_key(), "purpleInk");
        assert_eq!(PrIcon::Ready.hugeicon(), "Tick02Icon");
    }

    #[test]
    fn the_header_pill_names_draft_merged_and_closed() {
        let pill = pull_request_state_pill(PrState::Merged, false).unwrap();
        assert_eq!((pill.label, pill.fill, pill.ink), ("Merged", "purpleTint", "purpleInk"));
        let pill = pull_request_state_pill(PrState::Closed, true).unwrap();
        assert_eq!((pill.label, pill.fill, pill.ink), ("Closed", "redTint", "redInk"));
        let pill = pull_request_state_pill(PrState::Open, true).unwrap();
        assert_eq!((pill.label, pill.fill, pill.ink), ("Draft", "hover", "ink2"));
        assert_eq!(pull_request_state_pill(PrState::Open, false), None);
    }

    #[test]
    fn rows_put_blocked_first_then_open_merged_closed() {
        let open = pr(1);
        let merged = PullRequestStatus { state: PrState::Merged, ..pr(2) };
        let closed = PullRequestStatus { state: PrState::Closed, ..pr(3) };
        let blocked = PullRequestStatus { has_conflicts: true, ..pr(4) };
        let other_open = pr(5);
        let order: Vec<u32> = row_pull_requests(&[closed, merged, open, blocked, other_open]).iter().map(|p| p.number.unwrap()).collect();
        assert_eq!(order, vec![4, 1, 5, 2, 3]);
    }

    #[test]
    fn the_composer_action_is_the_first_undismissed_blocker_in_row_order() {
        let behind = PullRequestStatus { is_behind: true, ..pr(1) };
        let conflicted = PullRequestStatus { has_conflicts: true, is_behind: true, ..pr(2) };
        let clean = pr(3);
        let prs = [clean, behind.clone(), conflicted.clone()];
        // Both are blocked, so creation order decides: the behind PR comes first.
        let (found, blocker) = pull_request_action(&prs, &[]).unwrap();
        assert_eq!((found.number, blocker), (Some(1), Blocker::Behind));
        let dismissed = vec![format!("behind:{}", behind.url)];
        let (found, blocker) = pull_request_action(&prs, &dismissed).unwrap();
        assert_eq!((found.number, blocker), (Some(2), Blocker::Conflicts));
        let dismissed = vec![format!("behind:{}", behind.url), conflicted.url.clone()];
        let (found, blocker) = pull_request_action(&prs, &dismissed).unwrap();
        assert_eq!((found.number, blocker), (Some(2), Blocker::Behind));
        let dismissed = vec![format!("behind:{}", behind.url), conflicted.url.clone(), format!("behind:{}", conflicted.url)];
        assert_eq!(pull_request_action(&prs, &dismissed), None);
        assert_eq!(pull_request_action(&[pr(9)], &[]), None);
    }

    #[test]
    fn dismissals_survive_refreshes_and_clear_only_when_github_confirms() {
        let blocked = PullRequestStatus { checks: Some(Checks::Failed), has_conflicts: true, ..pr(7) };
        let after_click = update_blocker_dismissals(&[], Some(&blocked), Some(Blocker::ChecksFailed));
        assert_eq!(after_click, vec![format!("checks-failed:{}", blocked.url)]);
        // Clicking twice, or clicking a blocker that is not there, adds nothing.
        assert_eq!(update_blocker_dismissals(&after_click, Some(&blocked), Some(Blocker::ChecksFailed)), after_click);
        assert!(update_blocker_dismissals(&[], Some(&blocked), Some(Blocker::Behind)).is_empty());
        // A refresh that still shows the blocker keeps it hidden; a failed lookup keeps it too.
        assert_eq!(update_blocker_dismissals(&after_click, Some(&blocked), None), after_click);
        assert_eq!(update_blocker_dismissals(&after_click, None, None), after_click);
        // CI passed: the dismissal goes, so a later failure shows the action again.
        let passing = PullRequestStatus { has_conflicts: true, ..pr(7) };
        assert!(update_blocker_dismissals(&after_click, Some(&passing), None).is_empty());
    }

    #[test]
    fn a_conflict_dismissal_only_clears_when_the_merge_state_was_computed() {
        let url = pr(8).url;
        let dismissed = vec![url];
        let unknown = PullRequestStatus { conflict_status_known: Some(false), ..pr(8) };
        assert_eq!(update_blocker_dismissals(&dismissed, Some(&unknown), None), dismissed);
        let known = PullRequestStatus { conflict_status_known: Some(true), ..pr(8) };
        assert!(update_blocker_dismissals(&dismissed, Some(&known), None).is_empty());
        let absent = pr(8);
        assert!(update_blocker_dismissals(&dismissed, Some(&absent), None).is_empty());
        // Merged PRs clear everything.
        let merged = PullRequestStatus { state: PrState::Merged, ..pr(8) };
        assert!(update_blocker_dismissals(&dismissed, Some(&merged), None).is_empty());
    }

    #[test]
    fn auto_merge_label() {
        assert_eq!(AUTO_MERGE_LABEL, "Merges when ready");
    }
}
