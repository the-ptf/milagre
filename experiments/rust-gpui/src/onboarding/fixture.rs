//! The computer onboarding runs on, as a fixture, and the states a snapshot starts from.
//! `MILAGRE_GPUI_ONBOARDING=<name>`:
//!
//! | Name | Shows |
//! | --- | --- |
//! | `agent` | step 1: Claude ready, Codex signed out, Antigravity missing, Kiro self-installed |
//! | `agent-checking` | step 1 before the status arrives |
//! | `agent-signing-in` | Codex waiting for the browser |
//! | `project` | step 2 with the recent folders |
//! | `project-clone`, `project-create` | step 2 with the clone or create form filled in |
//! | `project-nogit` | step 2 with a folder without Git expanded |
//! | `project-empty` | step 2 with no agent history |
//! | `project-loading` | step 2 reading the history |
//! | `first-chat` | the first Chat's starters |

use super::model::{Account, AccountState, AgentFacts, AgentFolder, CliState};
use crate::data::Provider;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    Agent,
    AgentChecking,
    AgentSigningIn,
    Project,
    ProjectClone,
    ProjectCreate,
    ProjectNoGit,
    ProjectEmpty,
    ProjectLoading,
    FirstChat,
}

impl Scenario {
    pub fn from_name(name: &str) -> Option<Scenario> {
        Some(match name {
            "agent" => Scenario::Agent,
            "agent-checking" => Scenario::AgentChecking,
            "agent-signing-in" => Scenario::AgentSigningIn,
            "project" => Scenario::Project,
            "project-clone" => Scenario::ProjectClone,
            "project-create" => Scenario::ProjectCreate,
            "project-nogit" => Scenario::ProjectNoGit,
            "project-empty" => Scenario::ProjectEmpty,
            "project-loading" => Scenario::ProjectLoading,
            "first-chat" => Scenario::FirstChat,
            _ => return None,
        })
    }
}

/// The agents on this computer: what `agent:cli-status` and `accounts:list` answer.
pub fn agents() -> Vec<AgentFacts> {
    let account = |state, plan: Option<&str>| Account { id: "default".into(), state, plan: plan.map(Into::into), message: None };
    vec![
        AgentFacts { provider: Provider::Claude, cli: CliState::Ready, account: Some(account(AccountState::SignedIn, Some("Max"))) },
        AgentFacts { provider: Provider::Codex, cli: CliState::LoggedOut, account: Some(account(AccountState::SignedOut, None)) },
        AgentFacts { provider: Provider::Antigravity, cli: CliState::Missing, account: None },
        AgentFacts { provider: Provider::Kiro, cli: CliState::Missing, account: None },
    ]
}

/// `onboarding:agent-folders`: folders the agents worked in, newest first.
pub fn folders() -> Vec<AgentFolder> {
    let folder =
        |name: &str, path: &str, git, provider, days_ago| AgentFolder { name: name.into(), path: path.into(), git, provider, days_ago };
    vec![
        folder("happiergym", "/Users/me/Code/happiergym", true, Provider::Claude, 0),
        folder("milagre", "/Users/me/Code/milagre", true, Provider::Codex, 1),
        folder("recipes", "/Users/me/Documents/recipes", false, Provider::Claude, 3),
        folder("scratch", "/Users/me/Desktop/scratch", false, Provider::Codex, 9),
    ]
}
