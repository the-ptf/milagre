//! Which processes and ports are a Chat's: `chatProcesses` and `chatPorts` from ports.cjs.
//!
//! A port belongs to a Chat when the process listening on it was started by one of the agent's command shells or by
//! one of its Terminals. The agent CLI's other children (MCP servers) share its process group, while each command
//! shell leads its own, so only a child that is a shell or leads its own group counts. A server that outlived its
//! shell (`server &`) keeps the shell's group, so a Chat remembers the groups it has seen and keeps showing their ports
//! after the shell exits, and after the agent's session closes, until nothing in them runs any more. An unobserved
//! orphan has no proven Chat owner. Sharing a working directory never grants ownership.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::parse::{Listener, ProcessRow};

pub const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "sandbox-exec"];

/// One Chat's roots: its agent process, the execution agents (advisors) working for it, and its Terminals' shells.
/// `pid` is absent once the Chat's agent session closed (or for a Chat with only Terminals).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Root {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shells: Vec<i64>,
}

pub type Roots = HashMap<String, Root>;
/// Each Chat's process groups seen so far; `chat_processes` keeps it up to date.
pub type Groups = HashMap<String, HashSet<i64>>;

/// One of a Chat's ports, as `agent:ports` publishes it. `taskId` names the agent's background task that started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Port {
    pub port: i64,
    pub pid: i64,
    pub command: String,
    pub address: String,
    #[serde(rename = "taskId", default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

/// Every Chat's ports, sorted by port; Chats without ports are left out.
pub type ChatPorts = BTreeMap<String, Vec<Port>>;

/// `basename(command)`: after the last `/`, without a login shell's leading `-`.
pub fn basename(command: &str) -> &str {
    let name = command.rsplit('/').next().unwrap_or(command);
    name.strip_prefix('-').unwrap_or(name)
}

/// Merges Terminal shells into agent roots as runtime.cjs does: `{ ...roots.get(chatId), shells }`.
pub fn with_terminal_shells(mut roots: Roots, shells: impl IntoIterator<Item = (String, Vec<u32>)>) -> Roots {
    for (chat_id, pids) in shells {
        roots.entry(chat_id).or_default().shells = pids.into_iter().map(i64::from).collect();
    }
    roots
}

/// The pids that belong to each Chat's commands. `groups` is updated in place: a group is forgotten once nothing in it
/// runs.
pub fn chat_processes(processes: &[ProcessRow], roots: &Roots, groups: &mut Groups) -> HashMap<String, HashSet<i64>> {
    let mut children: HashMap<i64, Vec<&ProcessRow>> = HashMap::new();
    let by_pid: HashMap<i64, &ProcessRow> = processes.iter().map(|row| (row.pid, row)).collect();
    for row in processes {
        children.entry(row.ppid).or_default().push(row);
    }
    let mut chats: Vec<String> = roots.keys().cloned().collect();
    chats.extend(groups.keys().filter(|chat| !roots.contains_key(*chat)).cloned());
    let mut result = HashMap::new();
    for chat_id in chats {
        let known = groups.get(&chat_id).cloned().unwrap_or_default();
        let mut pids: HashSet<i64> = HashSet::new();
        let add = |row: &ProcessRow, pids: &mut HashSet<i64>| {
            let mut stack = vec![row.pid];
            while let Some(next) = stack.pop() {
                if !pids.insert(next) {
                    continue;
                }
                stack.extend(children.get(&next).into_iter().flatten().map(|child| child.pid));
            }
        };
        let root = roots.get(&chat_id);
        let agents: Vec<&ProcessRow> = root
            .into_iter()
            .flat_map(|root| root.pid.into_iter().chain(root.agents.iter().copied()))
            .filter_map(|pid| by_pid.get(&pid).copied())
            .collect();
        for agent in &agents {
            for child in children.get(&agent.pid).into_iter().flatten() {
                if SHELLS.contains(&basename(&child.command)) || child.pgid != agent.pgid {
                    add(child, &mut pids);
                }
            }
        }
        // A Terminal's shell and everything it started belong to its Chat.
        for pid in root.map(|root| root.shells.as_slice()).unwrap_or_default() {
            if let Some(row) = by_pid.get(pid) {
                add(row, &mut pids);
            }
        }
        for row in processes {
            if known.contains(&row.pgid) && !agents.iter().any(|agent| agent.pgid == row.pgid) {
                add(row, &mut pids);
            }
        }
        let live: HashSet<i64> = pids.iter().map(|pid| by_pid[pid].pgid).collect();
        if live.is_empty() {
            groups.remove(&chat_id);
        } else {
            groups.insert(chat_id.clone(), live);
        }
        if !pids.is_empty() {
            result.insert(chat_id, pids);
        }
    }
    result
}

/// Each Chat's ports from the listeners (first listener of a port wins, in lsof order) and each Chat's pids.
pub fn chat_ports(
    listeners: &[Listener],
    processes_by_chat: &HashMap<String, HashSet<i64>>,
    task_of: impl Fn(i64) -> Option<String>,
) -> ChatPorts {
    let mut result = ChatPorts::new();
    for (chat_id, pids) in processes_by_chat {
        let mut ports: Vec<Port> = Vec::new();
        for row in listeners {
            if !pids.contains(&row.pid) || ports.iter().any(|port| port.port == row.port) {
                continue;
            }
            ports.push(Port {
                port: row.port,
                pid: row.pid,
                command: row.command.clone(),
                address: row.address.clone(),
                task_id: task_of(row.pid),
            });
        }
        if !ports.is_empty() {
            ports.sort_by_key(|port| port.port);
            result.insert(chat_id.clone(), ports);
        }
    }
    result
}
