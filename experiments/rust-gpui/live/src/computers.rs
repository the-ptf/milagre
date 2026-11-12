//! Paired computers (`computers:*`, served by Milagre's daemon since `computer-management-v1`), shown only when the
//! daemon's computer vault is unlocked (`computers:vault-status []` → `{unlocked: true}`): Electron's main process
//! unlocks it with a key sealed in this Mac's keychain (`computer-unlock.cjs`), which the Preview does not hold, so a
//! daemon the Preview started itself stays locked and its computers stay hidden.
//!
//! Unlocked, `computers:list []` feeds Settings' computers group and their read-only pages ([`PreviewComputers`]).
//!
//! The shared client's `call()` does not send `computers:vault-status` (it is not one of the preload's renderer
//! commands: Electron's main process asks it), so today the read is refused before any request
//! (`Capability { required: "renderer:computers:vault-status" }`) and the computers UI stays hidden.

use milagre_gpui_spike::data::{Computer, ComputerState, ComputersSnapshot};
use serde_json::{Value, json};

use crate::daemon::Daemon;

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
    let status = match daemon.read(project, "computers:vault-status", json!([])).await {
        Ok(status) => status,
        Err(error) => return Vault::Refused(format!("{error:#}")),
    };
    if status["unlocked"] != true {
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
