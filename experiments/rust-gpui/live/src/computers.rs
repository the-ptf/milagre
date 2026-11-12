//! Paired computers (`computers:*`, served by Milagre's daemon since `computer-management-v1`), as Electron shows them:
//!
//! - The vault: the shared client's typed `computers:vault-status` (`{unlocked, configuredFile, hasVault,
//!   needsLegacyImport}`); while it is locked the computers stay hidden. The Preview unlocks it where Electron does
//!   (launch, every adoption, before `computers:add`, on `computers:set-enabled(true)`) with the client's
//!   `unlock_computers` (Electron's safeStorage key from the login Keychain, `computers:unlock`), and only when the
//!   status says it is locked ([`crate::daemon::Daemon::unlock_computers`]). A refused Keychain read
//!   (`KEYCHAIN_UNAVAILABLE`) shows [`ALLOW_KEYCHAIN`]; `VAULT_KEY_MISSING` (an existing vault without its key) never
//!   writes a new key. On a computer that never had Milagre.app (no vault, no key) the client creates the first key
//!   and its "Milagre Safe Storage" Keychain item as Electron does (`ComputerUnlock::Created`), so pairing works there
//!   too and a Milagre.app installed later reads the same key.
//! - Unlocked, `computers:list []` feeds the sidebar's computers and Settings' computers group.
//! - Each online computer's Projects, their states and its runs ([`Remote`]) are read with `computers:invoke [id,
//!   method, args]` (`project:recent`, `state:read`, `chat:runs`; a remote transcript with `chat:messages`) on the
//!   computers' own request-only connection (`Daemon::invoke`, Electron's `computers-lane.cjs`), so a slow computer
//!   never takes the window's request slots. Remote keys carry the computer (`<id>|<path>`, `qualifyKey`).

use std::collections::BTreeMap;

use milagre_gpui_spike::data::{ChatRuns, Computer, ComputerState, ComputersSnapshot, Project, StateRead};
use serde_json::{Value, json};

use crate::daemon::Daemon;

/// What the window says when the login Keychain refused Electron's computer key.
pub const ALLOW_KEYCHAIN: &str = "Allow Keychain access to use your paired computers.";

/// What an unlock found or did.
#[derive(Clone, Debug, PartialEq)]
pub enum Unlock {
    Done(milagre_daemon_client::ComputerUnlock),
    /// Locked, and this window does not unlock (read-only).
    Locked,
    /// The unlock failed: the client's code (`KEYCHAIN_UNAVAILABLE`, `VAULT_KEY_MISSING`, …) and message.
    Failed {
        code: String,
        message: String,
    },
}

impl Unlock {
    /// What the sidebar says about it, if anything.
    pub fn notice(&self) -> Option<String> {
        match self {
            Unlock::Failed { code, .. } if code == "KEYCHAIN_UNAVAILABLE" => Some(ALLOW_KEYCHAIN.to_owned()),
            Unlock::Failed { message, .. } => Some(format!("Your paired computers can't be used: {message}")),
            _ => None,
        }
    }
}

/// What the vault read found.
#[derive(Clone, Debug, PartialEq)]
pub enum Vault {
    Unlocked(ComputersSnapshot),
    Locked,
    /// The read was refused or failed: why, exactly.
    Refused(String),
}

/// `computers:vault-status`, then `computers:list` when unlocked, on a request-only connection of `project`.
pub async fn read(daemon: &Daemon, project: &str) -> Vault {
    let status = match daemon.vault_status(project).await {
        Ok(status) => status,
        Err(error) => return Vault::Refused(format!("{error:#}")),
    };
    if status["unlocked"] != true && status["configuredFile"] != true {
        return Vault::Locked;
    }
    match daemon.read(project, "computers:list", json!([])).await {
        Ok(list) => Vault::Unlocked(snapshot(&list)),
        Err(error) => Vault::Refused(format!("{error:#}")),
    }
}

/// A `computers:list` answer (`ComputersSnapshot`: `{thisMac, computers: [{id, name, state, message}], enabled}`) as
/// the window's snapshot.
pub fn snapshot(list: &Value) -> ComputersSnapshot {
    let this_mac = list["thisMac"].as_str().unwrap_or("This computer").to_owned();
    let computers = list["computers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let state = match c["state"].as_str() {
                Some("off") => ComputerState::Off,
                Some("online") => ComputerState::Online,
                Some("connecting") => ComputerState::Connecting,
                Some("reconnecting") => ComputerState::Reconnecting,
                Some("refused") => ComputerState::Refused,
                _ => ComputerState::Offline,
            };
            Some(Computer {
                id: c["id"].as_str()?.to_owned().into(),
                name: c["name"].as_str().unwrap_or("Computer").to_owned().into(),
                state,
                message: c["message"].as_str().map(|m| m.to_owned().into()),
            })
        })
        .collect();
    ComputersSnapshot { this_mac: this_mac.into(), computers }
}

/// A key as its own computer names it (`unqualifyKey`): `<id>|/path` is `/path`.
pub fn bare<'a>(id: &str, key: &'a str) -> &'a str {
    key.strip_prefix(id).and_then(|rest| rest.strip_prefix('|')).unwrap_or(key)
}

/// A paired computer's key as this window keeps it (`qualifyKey`).
pub fn qualify(id: &str, key: &str) -> String {
    if key.starts_with(&format!("{id}|")) { key.to_owned() } else { format!("{id}|{key}") }
}

/// What the window holds of one paired computer: its Projects (in its recent order), each one's state by qualified
/// scope key, and its runs by qualified Chat key.
#[derive(Clone, Debug, Default)]
pub struct Remote {
    pub projects: Vec<Project>,
    pub states: BTreeMap<String, StateRead>,
    pub runs: ChatRuns,
}

/// How many of a computer's Projects are read (Electron's sidebar shows the recent ones).
pub const REMOTE_PROJECTS: usize = 12;

/// One online computer's Projects, states and runs through `computers:invoke`. `Err` when it does not answer.
pub async fn read_remote(daemon: &Daemon, id: &str) -> anyhow::Result<Remote> {
    let recent = daemon.invoke(id, "project:recent", json!([])).await?;
    let mut remote = Remote::default();
    for project in recent.as_array().into_iter().flatten().take(REMOTE_PROJECTS) {
        let Some(path) = project["path"].as_str() else { continue };
        let path = bare(id, path).to_owned();
        let name = project["name"].as_str().unwrap_or(&path).to_owned();
        let project = Project {
            path: path.clone().into(),
            name: name.into(),
            git: project["git"].as_bool().unwrap_or(true),
            kind: milagre_gpui_spike::data::ProjectKind::from_wire(project["kind"].as_str()),
            hidden: project["hidden"] == true,
            origin: project["origin"].as_str().map(|o| o.to_owned().into()),
            opened_at: project["openedAt"].as_str().map(|o| o.to_owned().into()),
            computer: id.to_owned().into(),
            tile: None,
            image: None,
        };
        let scope = project.scope();
        if !project.hidden
            && let Ok(read) = daemon.invoke(id, "state:read", json!([path])).await
        {
            let read = milagre_daemon_client::StateRead {
                state: read["state"].clone(),
                version: read["version"].clone(),
                epoch: read["epoch"].clone(),
            };
            if let Ok(state) = crate::map::state_read(&read) {
                remote.states.insert(scope.as_str().to_owned(), state);
            }
        }
        remote.projects.push(project);
    }
    if let Ok(runs) = daemon.invoke(id, "chat:runs", json!([])).await {
        let runs = milagre_daemon_client::ChatRuns { runs: runs["runs"].clone(), seq: runs["seq"].as_u64().unwrap_or(0) };
        if let Ok(mut decoded) = crate::map::chat_runs(&runs) {
            decoded.runs = decoded.runs.into_iter().map(|(key, run)| (qualify(id, &key), run)).collect();
            remote.runs = decoded;
        }
    }
    Ok(remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_keys_carry_their_computer() {
        assert_eq!(bare("tianxu", "tianxu|/work/a"), "/work/a");
        assert_eq!(bare("tianxu", "/work/a"), "/work/a");
        assert_eq!(qualify("tianxu", "/work/a#3"), "tianxu|/work/a#3");
        assert_eq!(qualify("tianxu", "tianxu|/work/a#3"), "tianxu|/work/a#3");
        assert_eq!(Unlock::Failed { code: "KEYCHAIN_UNAVAILABLE".into(), message: "x".into() }.notice().as_deref(), Some(ALLOW_KEYCHAIN));
        assert_eq!(Unlock::Done(milagre_daemon_client::ComputerUnlock::Created).notice(), None);
    }
}
