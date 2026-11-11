//! `git-codes.mjs`: the Git error codes the host answers with and the sentences the UI shows for them.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCode {
    NoOrigin,
    Detached,
    DetachedCommit,
    GhMissing,
    WorktreeChanged,
}

impl GitCode {
    /// The wire name (`NO_ORIGIN`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoOrigin => "NO_ORIGIN",
            Self::Detached => "DETACHED",
            Self::DetachedCommit => "DETACHED_COMMIT",
            Self::GhMissing => "GH_MISSING",
            Self::WorktreeChanged => "WORKTREE_CHANGED",
        }
    }

    pub fn from_wire(code: &str) -> Option<Self> {
        [Self::NoOrigin, Self::Detached, Self::DetachedCommit, Self::GhMissing, Self::WorktreeChanged]
            .into_iter()
            .find(|c| c.as_str() == code)
    }
}

/// How to install gh where it runs: the host, which may be another computer than the one showing the message.
fn gh_missing(platform: &str) -> String {
    let how = match platform {
        "darwin" => "`brew install gh`",
        "win32" => "`winget install --id GitHub.cli`",
        _ => "cli.github.com",
    };
    format!("Install the GitHub CLI ({how}) to open PRs.")
}

/// The message for a code; `platform` is the host's Node platform name (`darwin`, `win32`, `linux`), for the steps
/// that differ by platform (installing gh). Without one, gh is explained for macOS, as `GIT_MESSAGES` does.
pub fn git_message(code: GitCode, platform: Option<&str>) -> String {
    match code {
        GitCode::NoOrigin => "This repo has no origin remote.".to_string(),
        GitCode::Detached => "Check out a branch to push.".to_string(),
        GitCode::DetachedCommit => "Check out a branch to commit.".to_string(),
        GitCode::GhMissing => gh_missing(platform.filter(|p| !p.is_empty()).unwrap_or("darwin")),
        GitCode::WorktreeChanged => "It changed after you checked, so the chat and its worktree stay.".to_string(),
    }
}
