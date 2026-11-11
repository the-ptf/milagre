//! Each computer's keybindings as its host answers them (`keybindings:read`, `:set-command`, `:reset`): the global
//! [`KeybindingsStore`], made on first use from a deterministic fixture. Nothing is read from disk or the daemon, and
//! "Open keybindings.json" only counts the press.

use std::collections::BTreeMap;

use gpui::{App, Global};

use super::logic::{Edit, apply_edit};
use crate::data::LOCAL;
use crate::logic::keybindings::{KeybindingRule, KeybindingsState, default_keybindings};

/// What one computer holds.
#[derive(Clone, Debug, Default)]
pub struct ComputerKeys {
    pub state: KeybindingsState,
    /// A computer that cannot answer: its Milagre is too old, or the read failed.
    pub read_error: Option<String>,
    /// A computer that refuses writes.
    pub write_error: Option<String>,
    pub writes: usize,
}

#[derive(Clone, Debug, Default)]
pub struct KeybindingsStore {
    computers: BTreeMap<String, ComputerKeys>,
    /// This window's Advanced switch: conditions are edited only while it is on.
    pub advanced: bool,
    /// How many times "Open keybindings.json" was pressed.
    pub opened_file: usize,
}

impl Global for KeybindingsStore {}

pub fn init(cx: &mut App) {
    if !cx.has_global::<KeybindingsStore>() {
        cx.set_global(KeybindingsStore::default());
    }
}

/// This computer's file: the defaults, a second key for Terminals and a condition on the theme switch.
fn fixture_rules() -> Vec<KeybindingRule> {
    let mut rules: Vec<KeybindingRule> =
        default_keybindings().into_iter().filter(|rule| rule.command != "terminal.toggle" && rule.command != "theme.toggle").collect();
    rules.push(KeybindingRule::new("mod+j", "terminal.toggle"));
    rules.push(KeybindingRule::new("mod+`", "terminal.toggle"));
    rules.push(KeybindingRule::new("mod+shift+t", "theme.toggle").with_when("!terminalFocus"));
    rules
}

fn fixture(id: &str) -> ComputerKeys {
    if id == LOCAL {
        ComputerKeys {
            state: KeybindingsState { path: "~/.milagre/keybindings.json".into(), rules: fixture_rules(), issues: Vec::new() },
            ..ComputerKeys::default()
        }
    } else {
        ComputerKeys {
            state: KeybindingsState { path: "~/.milagre/keybindings.json".into(), rules: default_keybindings(), issues: Vec::new() },
            ..ComputerKeys::default()
        }
    }
}

impl KeybindingsStore {
    fn entry(&mut self, id: &str) -> &mut ComputerKeys {
        self.computers.entry(id.to_string()).or_insert_with(|| fixture(id))
    }

    /// The computer's keybindings as read now.
    pub fn get(&self, id: &str) -> ComputerKeys {
        self.computers.get(id).cloned().unwrap_or_else(|| fixture(id))
    }

    /// `keybindings:set-command` for each command of the edit, in order.
    pub fn apply(&mut self, id: &str, edit: &Edit) -> Result<(), String> {
        let keys = self.entry(id);
        if let Some(error) = keys.write_error.clone() {
            return Err(error);
        }
        keys.state.rules = apply_edit(&keys.state.rules, edit);
        keys.writes += 1;
        Ok(())
    }

    /// `keybindings:reset`.
    pub fn reset_all(&mut self, id: &str) -> Result<(), String> {
        let keys = self.entry(id);
        if let Some(error) = keys.write_error.clone() {
            return Err(error);
        }
        keys.state.rules = default_keybindings();
        keys.state.issues.clear();
        keys.writes += 1;
        Ok(())
    }

    /// Fixture controls the tests use.
    pub fn set_write_error(&mut self, id: &str, error: Option<&str>) {
        self.entry(id).write_error = error.map(str::to_string);
    }

    pub fn set_read_error(&mut self, id: &str, error: Option<&str>) {
        self.entry(id).read_error = error.map(str::to_string);
    }

    pub fn set_issues(&mut self, id: &str, issues: &[&str]) {
        self.entry(id).state.issues = issues.iter().map(|issue| issue.to_string()).collect();
    }
}
