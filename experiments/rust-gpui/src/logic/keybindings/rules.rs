//! Rules: reading, compiling, matching, conflicts and the merging of a user's edits with the defaults.

use super::catalog::{KEYBINDING_COMMANDS, KeybindingCommand};
use super::keys::{KeyEvent, KeyShortcut, canonical_key, event_matches, has_command_modifier, parse_key};
use super::when::{WhenContext, WhenNode, evaluate_when, parse_when};
use std::collections::HashSet;

/// At most this many rules are read from a file; the rest are left out.
pub const MAX_KEYBINDINGS: usize = 256;

/// One line of keybindings.json. An empty `when` counts as none, as in the TS (`rule.when` is falsy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingRule {
    pub key: String,
    pub command: String,
    pub when: Option<String>,
}

impl KeybindingRule {
    pub fn new(key: &str, command: &str) -> Self {
        Self { key: key.to_string(), command: command.to_string(), when: None }
    }

    pub fn with_when(mut self, when: &str) -> Self {
        self.when = Some(when.to_string());
        self
    }

    /// The `when` text, or `None` when absent or empty.
    pub(crate) fn when_text(&self) -> Option<&str> {
        self.when.as_deref().filter(|w| !w.is_empty())
    }
}

/// A computer's keybindings, as its host reads keybindings.json.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeybindingsState {
    /// The file's path on that computer.
    pub path: String,
    pub rules: Vec<KeybindingRule>,
    /// A line per entry left out, or the reason the whole file was (then `rules` are the defaults).
    pub issues: Vec<String>,
}

/// The command's catalogue entry, or `None` for an unknown id.
pub fn keybinding_command(id: &str) -> Option<&'static KeybindingCommand> {
    KEYBINDING_COMMANDS.iter().find(|c| c.id == id)
}

/// The default rules, in catalogue order.
pub fn default_keybindings() -> Vec<KeybindingRule> {
    KEYBINDING_COMMANDS.iter().flat_map(|c| c.defaults.iter().map(|key| KeybindingRule::new(key, c.id))).collect()
}

/// The default rules of one command.
pub fn default_rules_for(command: &str) -> Vec<KeybindingRule> {
    keybinding_command(command).map(|c| c.defaults.iter().map(|key| KeybindingRule::new(key, c.id)).collect()).unwrap_or_default()
}

/// A rule as a file's entry gives it: the strings of an object that had string fields. Entries that are not objects
/// or have non-string fields are for the code that reads the JSON (the host); this reads what is left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRule {
    pub key: String,
    pub command: String,
    pub when: Option<String>,
}

/// JSON.stringify of a string, for the messages.
fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A rule from a file's entry, trimmed, or the reason it can't be one.
pub fn read_rule(entry: &RawRule) -> Result<KeybindingRule, String> {
    if keybinding_command(&entry.command).is_none() {
        return Err(format!("has an unknown command {}", json_string(&entry.command)));
    }
    if parse_key(&entry.key).is_none() {
        return Err(format!("has a key Milagre can't read: {}", json_string(&entry.key)));
    }
    if let Some(when) = &entry.when
        && parse_when(when).is_none()
    {
        return Err(format!("has a when it can't read: {}", json_string(when)));
    }
    Ok(KeybindingRule {
        key: entry.key.trim_matches(super::is_js_space).to_string(),
        command: entry.command.clone(),
        when: entry.when.as_deref().map(|w| w.trim_matches(super::is_js_space).to_string()),
    })
}

/// The valid rules of a file's entries, and a line per entry left out.
pub fn read_rules(entries: &[RawRule]) -> (Vec<KeybindingRule>, Vec<String>) {
    let mut rules = Vec::new();
    let mut issues = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if rules.len() >= MAX_KEYBINDINGS {
            issues.push(format!("Only the first {MAX_KEYBINDINGS} rules are read."));
            break;
        }
        match read_rule(entry) {
            Ok(rule) => rules.push(rule),
            Err(error) => issues.push(format!("Rule {} {error}.", index + 1)),
        }
    }
    (rules, issues)
}

/// A rule ready to match: with its parsed key and `when`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledRule {
    pub rule: KeybindingRule,
    pub shortcut: KeyShortcut,
    pub when_tree: Option<WhenNode>,
}

/// Rules ready to match; one whose key or `when` does not parse is left out.
pub fn compile_rules(rules: &[KeybindingRule]) -> Vec<CompiledRule> {
    rules
        .iter()
        .filter_map(|rule| {
            let shortcut = parse_key(&rule.key)?;
            let when_tree = match rule.when_text() {
                Some(text) => Some(parse_when(text)?),
                None => None,
            };
            Some(CompiledRule { rule: rule.clone(), shortcut, when_tree })
        })
        .collect()
}

fn last_match<'a>(compiled: &'a [CompiledRule], event: &KeyEvent, context: &WhenContext, mac: bool, either: bool) -> Option<&'a str> {
    compiled
        .iter()
        .rev()
        .find(|rule| {
            event_matches(event, &rule.shortcut, mac, either) && rule.when_tree.as_ref().is_none_or(|tree| evaluate_when(tree, context))
        })
        .map(|rule| rule.rule.command.as_str())
}

/// The command a keyboard event runs: the last rule whose key and `when` both match, or `None`. A `mod` key answers to
/// Cmd or Ctrl (see `event_matches`), but a rule that names the pressed modifier exactly wins over one that only allows it.
pub fn command_for_event<'a>(compiled: &'a [CompiledRule], event: &KeyEvent, context: &WhenContext, mac: bool) -> Option<&'a str> {
    [false, true].into_iter().find_map(|either| last_match(compiled, event, context, mac, either))
}

/// What the desktop does with a key press: [`command_for_event`], except a key with no Cmd, Ctrl or Alt (a hand-edited
/// `"k"`) never runs while a field has the keyboard (`editableFocus`), so typing still types. From `shortcutCommand`
/// in `apps/desktop/app/src/lib/keybindings.ts`.
pub fn shortcut_command<'a>(compiled: &'a [CompiledRule], event: &KeyEvent, context: &WhenContext, mac: bool) -> Option<&'a str> {
    let command = command_for_event(compiled, event, context, mac)?;
    if !context.is_true("editableFocus") {
        return Some(command);
    }
    let rule = compiled.iter().rev().find(|item| item.rule.command == command)?;
    has_command_modifier(&rule.rule.key).then_some(command)
}

/// The key strings a command has, in file order.
pub fn keys_for<'a>(rules: &'a [KeybindingRule], command: &str) -> Vec<&'a str> {
    rules.iter().filter(|rule| rule.command == command).map(|rule| rule.key.as_str()).collect()
}

/// The key a command shows in a hint: the LAST rule of the command whose `when` can hold in `context` (every rule
/// without a context). The TS comment says "first" but the loop runs from the end, so the last rule wins, as in
/// matching; ported as the code behaves.
pub fn primary_key_for<'a>(rules: &'a [KeybindingRule], command: &str, context: Option<&WhenContext>) -> Option<&'a str> {
    for rule in rules.iter().rev() {
        if rule.command != command {
            continue;
        }
        if let (Some(context), Some(when)) = (context, rule.when_text()) {
            match parse_when(when) {
                Some(tree) if evaluate_when(&tree, context) => {}
                _ => continue,
            }
        }
        return Some(&rule.key);
    }
    None
}

/// The commands other than `command` that a key already runs, ignoring rules whose `when` differs (they may never
/// meet). `when` compares as written. In first-seen order.
pub fn conflicts_for(rules: &[KeybindingRule], key: &str, command: &str, when: Option<&str>, mac: bool) -> Vec<String> {
    let Some(wanted) = canonical_key(key, mac) else { return Vec::new() };
    let mut others: Vec<String> = Vec::new();
    for rule in rules {
        if rule.command == command {
            continue;
        }
        if rule.when.as_deref().unwrap_or("") != when.unwrap_or("") {
            continue;
        }
        if canonical_key(&rule.key, mac).as_deref() == Some(wanted.as_str()) && !others.contains(&rule.command) {
            others.push(rule.command.clone());
        }
    }
    others
}

/// A key (and `when`) to bind, before it has a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleDraft {
    pub key: String,
    pub when: Option<String>,
}

impl RuleDraft {
    pub fn new(key: &str) -> Self {
        Self { key: key.to_string(), when: None }
    }
}

/// `rules` with every rule of `command` replaced by `next`, added at the end so they win over earlier ones.
pub fn with_command_rules(rules: &[KeybindingRule], command: &str, next: &[RuleDraft]) -> Vec<KeybindingRule> {
    rules
        .iter()
        .filter(|rule| rule.command != command)
        .cloned()
        .chain(next.iter().map(|draft| KeybindingRule { key: draft.key.clone(), command: command.to_string(), when: draft.when.clone() }))
        .collect()
}

/// Whether a command's rules are exactly its defaults.
pub fn is_default(rules: &[KeybindingRule], command: &str) -> bool {
    let mine: Vec<&KeybindingRule> = rules.iter().filter(|rule| rule.command == command).collect();
    let defaults: &[&str] = keybinding_command(command).map_or(&[], |c| c.defaults);
    mine.len() == defaults.len() && mine.iter().zip(defaults).all(|(rule, default)| rule.when_text().is_none() && rule.key == *default)
}

/// The result of [`add_new_defaults`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddedDefaults {
    pub rules: Vec<KeybindingRule>,
    /// The commands now seen, in the order they were first seen.
    pub seen: Vec<String>,
    pub added: bool,
}

/// The file's rules with the defaults of commands it has never seen added at the end (a newer Milagre brought them),
/// and the commands now seen. A command whose rules the user removed stays unbound: it is already seen.
pub fn add_new_defaults(rules: &[KeybindingRule], seen: &[String]) -> AddedDefaults {
    let mut known: Vec<String> = Vec::new();
    let mut known_set: HashSet<&str> = HashSet::new();
    for id in seen {
        if known_set.insert(id) {
            known.push(id.clone());
        }
    }
    let mut known_set: HashSet<String> = known.iter().cloned().collect();
    let mut added: Vec<KeybindingRule> = Vec::new();
    for command in KEYBINDING_COMMANDS {
        if known_set.contains(command.id) {
            continue;
        }
        known_set.insert(command.id.to_string());
        known.push(command.id.to_string());
        if rules.iter().any(|rule| rule.command == command.id) {
            continue;
        }
        added.extend(command.defaults.iter().map(|key| KeybindingRule::new(key, command.id)));
    }
    let did_add = !added.is_empty();
    let mut next = rules.to_vec();
    next.extend(added);
    AddedDefaults { rules: next, seen: known, added: did_add }
}

/// The `chat.jump.N` command's Chat index (from 0), or `None` for any other command.
pub fn chat_jump_index(command: Option<&str>) -> Option<usize> {
    let digit = command?.strip_prefix("chat.jump.")?;
    let mut chars = digit.chars();
    match (chars.next(), chars.next()) {
        (Some(c @ '1'..='9'), None) => Some(c as usize - '1' as usize),
        _ => None,
    }
}

/// The `chat.jump.N` command of the Chat at `index` (from 0), for its row's hint.
pub fn chat_jump_command(index: usize) -> String {
    format!("chat.jump.{}", index + 1)
}
