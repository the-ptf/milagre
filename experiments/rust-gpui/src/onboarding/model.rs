//! What onboarding shows and the rules behind it. After `Onboarding.tsx`: `agentRows`, `SELF_INSTALLED`, `homePath`,
//! `lastUsedLabel`, `firstChatStarters`, and the types of `agent:cli-status`, `accounts:*` and `onboarding:*`.

use crate::data::Provider;

/// The agent list's order (`PROVIDERS` in `Onboarding.tsx`).
pub const PROVIDERS: [Provider; 4] = [Provider::Claude, Provider::Codex, Provider::Antigravity, Provider::Kiro];

/// What this computer calls itself in the copy (`thisComputer`: "this Mac" on macOS).
pub const THIS_COMPUTER: &str = "this Mac";
/// Where Start from scratch makes the folder (`onboarding-projects.cjs`: `<home>/Code`).
pub const CODE_FOLDER: &str = "~/Code";

/// `AgentCliStatus[provider].state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliState {
    Missing,
    Broken,
    Outdated,
    LoggedOut,
    Ready,
}

/// `Account.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountState {
    SignedIn,
    SigningIn,
    SignedOut,
    Error,
}

/// The selected account of a provider (`AccountsSnapshot`'s `selectedId` or first).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub state: AccountState,
    pub plan: Option<String>,
    pub message: Option<String>,
}

/// What `agent:cli-status` and `accounts:list` say of one provider on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentFacts {
    pub provider: Provider,
    pub cli: CliState,
    pub account: Option<Account>,
}

/// One row of the agent step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Checking,
    Ready,
    Missing,
    Outdated,
    SignedOut,
    SigningIn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRow {
    pub provider: Provider,
    pub state: RowState,
    pub detail: String,
    pub account_id: Option<String>,
}

/// `agentRows`: `None` until the first status arrives (every row "Checking\u{2026}").
pub fn agent_rows(facts: Option<&[AgentFacts]>) -> Vec<AgentRow> {
    PROVIDERS
        .iter()
        .map(|&provider| {
            let Some(fact) = facts.and_then(|all| all.iter().find(|fact| fact.provider == provider)) else {
                return AgentRow {
                    provider,
                    state: RowState::Checking,
                    detail: format!("Checking {THIS_COMPUTER}\u{2026}"),
                    account_id: None,
                };
            };
            let account = fact.account.as_ref();
            let row = |state, detail: String, account_id: Option<String>| AgentRow { provider, state, detail, account_id };
            match fact.cli {
                CliState::Missing | CliState::Broken => row(
                    RowState::Missing,
                    if fact.cli == CliState::Broken {
                        "Installed, but it doesn\u{2019}t start".into()
                    } else {
                        format!("Not found on {THIS_COMPUTER}")
                    },
                    None,
                ),
                CliState::Outdated => row(RowState::Outdated, "Installed \u{b7} needs an update".into(), None),
                _ if account.is_some_and(|a| a.state == AccountState::SigningIn) => {
                    row(RowState::SigningIn, "Finish signing in in your browser".into(), account.map(|a| a.id.clone()))
                }
                // An account that could not be checked, or whose sign-in failed, is no sign-in: its message says why.
                _ if fact.cli == CliState::LoggedOut
                    || account.is_some_and(|a| matches!(a.state, AccountState::SignedOut | AccountState::Error)) =>
                {
                    let detail = account
                        .filter(|a| a.state == AccountState::Error)
                        .and_then(|a| a.message.clone())
                        .unwrap_or_else(|| "Installed \u{b7} not signed in".into());
                    row(RowState::SignedOut, detail, account.map(|a| a.id.clone()))
                }
                _ => row(
                    RowState::Ready,
                    match account.and_then(|a| a.plan.as_deref()) {
                        Some(plan) => format!("Signed in \u{b7} {plan} plan"),
                        None => "Signed in".into(),
                    },
                    account.map(|a| a.id.clone()),
                ),
            }
        })
        .collect()
}

/// An agent whose CLI people install and update themselves (`cli-update.cjs` refuses them): its row says how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelfInstalled {
    /// The terminal command to install it, when this platform has one.
    pub install: Option<&'static str>,
    pub update: &'static str,
    pub site: &'static str,
}

pub fn self_installed(provider: Provider) -> Option<SelfInstalled> {
    (provider == Provider::Kiro).then_some(SelfInstalled {
        install: Some("brew install --cask kiro-cli"),
        update: "kiro-cli update",
        site: "https://kiro.dev",
    })
}

/// A row's detail line, with a self-installed agent's own words and the copied note.
pub fn row_detail(row: &AgentRow, copied: bool) -> String {
    if copied {
        return "Copied. Run it in a terminal, then come back here.".into();
    }
    match (self_installed(row.provider), row.state) {
        (Some(own), RowState::Missing) if own.install.is_some() => format!("Not found on {THIS_COMPUTER} \u{b7} install it with Homebrew"),
        (Some(own), RowState::Missing) => {
            format!("Not found on {THIS_COMPUTER} \u{b7} install it from {}", own.site.trim_start_matches("https://"))
        }
        (Some(own), RowState::Outdated) => format!("Installed \u{b7} update it with {}", own.update),
        _ => row.detail.clone(),
    }
}

/// `~/Code/web` for `/Users/me/Code/web`, so a path reads the way people say it.
pub fn home_path(folder: &str) -> String {
    for root in ["/Users/", "/home/"] {
        if let Some(rest) = folder.strip_prefix(root) {
            return match rest.split_once('/') {
                Some((_, tail)) => format!("~/{tail}"),
                None => "~".into(),
            };
        }
    }
    folder.to_string()
}

/// `inCode`: where a new project's folder will be.
pub fn in_code(name: &str) -> String {
    format!("{CODE_FOLDER}/{name}")
}

/// `AgentFolder`: a folder an agent worked in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentFolder {
    pub name: String,
    pub path: String,
    pub git: bool,
    pub provider: Provider,
    /// Whole days ago it was last used.
    pub days_ago: u32,
}

/// `lastUsedLabel`: "today", "yesterday", "3 days ago", "last week", or the date (here "2+ weeks ago": the fixture has
/// no calendar).
pub fn last_used_label(days: u32) -> String {
    match days {
        0 => "today".into(),
        1 => "yesterday".into(),
        2..=6 => format!("{days} days ago"),
        7..=13 => "last week".into(),
        _ => format!("{} weeks ago", days / 7),
    }
}

/// "Claude and Codex" for the folders' sources, in first-seen order.
pub fn sources(folders: &[AgentFolder]) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    for folder in folders {
        let name = folder.provider.name();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// The project name a clone address ends in (`https://github.com/owner/repo.git` is `repo`).
pub fn repository_name(address: &str) -> String {
    let last = address.trim().trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or("");
    last.trim_end_matches(".git").to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Agent,
    Project,
}

impl Step {
    pub fn number(self) -> usize {
        match self {
            Step::Agent => 1,
            Step::Project => 2,
        }
    }
}

/// The three steps of the header; the third is the app's first Chat.
pub const STEPS: [&str; 3] = ["Agent", "Project", "First Chat"];

/// `Starter`: a first-Chat task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Starter {
    pub id: &'static str,
    pub label: String,
    pub prompt: String,
}

/// `firstChatStarters` for a Project named `name`.
pub fn first_chat_starters(name: &str) -> Vec<Starter> {
    vec![
        Starter {
            id: "explain",
            label: format!("Explain how {name} is put together"),
            prompt: format!("Explain how {name} is put together: its main parts, how they connect, and where to start reading."),
        },
        Starter {
            id: "bug",
            label: "Find a bug and fix it".into(),
            prompt: "Look through this project for a real bug, explain it, and fix it.".into(),
        },
        Starter {
            id: "tests",
            label: "Add tests for the most recent change".into(),
            prompt: "Find the most recent change in this project and add tests that cover it.".into(),
        },
    ]
}
