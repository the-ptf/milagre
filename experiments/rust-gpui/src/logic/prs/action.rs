//! After `packages/shared/src/pr-action.mjs`: what each PR-blocker pill asks for and the prompt it sends.

use super::blockers::Blocker;

/// One entry of `PR_ACTIONS`: the pill label, the line the Chat keeps, and the bundled skill's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrAction {
    pub label: &'static str,
    pub sentence: &'static str,
    pub skill: &'static str,
}

/// `PR_ACTIONS[blocker]`.
pub fn pr_action(blocker: Blocker) -> PrAction {
    match blocker {
        Blocker::Conflicts => PrAction {
            label: "Resolve conflicts",
            sentence: "Resolve the conflicts on pull request",
            skill: "milagre-resolve-conflicts",
        },
        Blocker::ChangesRequested => PrAction {
            label: "Address review",
            sentence: "Address the review on pull request",
            skill: "milagre-address-review",
        },
        Blocker::ChecksFailed => {
            PrAction { label: "Fix CI", sentence: "Fix CI on pull request", skill: "milagre-fix-ci" }
        }
        Blocker::Behind => PrAction {
            label: "Update branch",
            sentence: "Update the branch of pull request",
            skill: "milagre-update-branch",
        },
    }
}

/// A checked PR action request (`{ kind: "pr-action", action, pr, url }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrActionContext {
    pub action: Blocker,
    pub pr: u64,
    pub url: String,
}

/// A GitHub-style PR URL (any https host, so Enterprise works) ending at the pull request: the number in it.
fn pull_request_url_number(url: &str) -> Option<u64> {
    let rest = url.strip_prefix("https://")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [host, owner, repo, pull, number] = parts.as_slice() else { return None };
    let segment_ok = |segment: &str| !segment.is_empty() && !segment.chars().any(crate::logic::copy::js::is_space);
    if !(segment_ok(host) && segment_ok(owner) && segment_ok(repo) && *pull == "pull") {
        return None;
    }
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

/// `pullRequestActionContext`: `None` unless the action is known and the URL is that pull request's.
/// `action` is the raw string; `pr` the raw number (7.5 and 0 are refused).
pub fn pull_request_action_context(action: &str, pr: f64, url: &str) -> Option<PrActionContext> {
    let action = Blocker::from_key(action)?;
    if !(pr.fract() == 0.0 && pr > 0.0 && pr <= 9_007_199_254_740_991.0) {
        return None;
    }
    let number = pull_request_url_number(url)?;
    if number as f64 != pr {
        return None;
    }
    Some(PrActionContext { action, pr: number, url: url.to_string() })
}

/// The short line the Chat shows: "Fix CI on pull request #77".
pub fn pull_request_action_body(context: &PrActionContext) -> String {
    format!("{} #{}", pr_action(context.action).sentence, context.pr)
}

/// What the agent is sent: the line, the URL, then the skill token.
pub fn pull_request_action_prompt(context: &PrActionContext) -> String {
    format!("{} ({}). /{}", pull_request_action_body(context), context.url, pr_action(context.action).skill)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://github.com/the-ptf/milagre-ade/pull/77";

    #[test]
    fn a_valid_request_becomes_a_pr_action_context() {
        let context = pull_request_action_context("checks-failed", 77.0, URL).unwrap();
        assert_eq!(context, PrActionContext { action: Blocker::ChecksFailed, pr: 77, url: URL.into() });
    }

    #[test]
    fn github_enterprise_urls_are_accepted() {
        let enterprise = "https://github.example.com/org/repo/pull/12";
        assert_eq!(pull_request_action_context("behind", 12.0, enterprise).unwrap().url, enterprise);
    }

    #[test]
    fn malformed_requests_are_refused() {
        let cases: [(&str, f64, &str); 8] = [
            ("deploy", 77.0, URL),
            ("checks-failed", 0.0, URL),
            ("checks-failed", 7.5, URL),
            ("checks-failed", 78.0, URL),
            ("checks-failed", 77.0, "http://github.com/a/b/pull/77"),
            ("checks-failed", 77.0, "https://github.com/a/b/pull/77/files"),
            ("toString", 77.0, URL),
            ("checks-failed", 77.0, "https://github.com/a/b/pull/77 "),
        ];
        for (action, pr, url) in cases {
            assert_eq!(pull_request_action_context(action, pr, url), None, "{action} {pr} {url}");
        }
        assert_eq!(pull_request_action_context("checks-failed", f64::NAN, URL), None);
    }

    #[test]
    fn body_is_the_short_line_and_prompt_adds_the_url_and_skill() {
        let context = pull_request_action_context("checks-failed", 77.0, URL).unwrap();
        assert_eq!(pull_request_action_body(&context), "Fix CI on pull request #77");
        assert_eq!(pull_request_action_prompt(&context), format!("Fix CI on pull request #77 ({URL}). /milagre-fix-ci"));
    }

    #[test]
    fn every_blocker_has_an_action_whose_label_is_the_one_blockers_shows() {
        for blocker in Blocker::ORDER {
            assert_eq!(blocker.action_label(), pr_action(blocker).label);
            assert!(pr_action(blocker).skill.starts_with("milagre-"));
        }
    }
}
