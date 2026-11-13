//! The rules of Settings › Keybindings, apart from any drawing (`KeybindingsSettings.tsx`): which rules a command
//! owns, what pressing a key does while one is being recorded, the edits a recorded key, a removal, a condition or a
//! reset make, the search, and the checks on a `when` field. Everything is a function of the rules.

use gpui::Keystroke;

use crate::logic::keybindings::KeybindingRule;
use crate::logic::keybindings::keys::{KeyEvent, canonical_key, has_command_modifier, is_modifier_event, key_from_event};
use crate::logic::keybindings::rules::{RuleDraft, conflicts_for, default_rules_for, keybinding_command, with_command_rules};
use crate::logic::keybindings::when::{WHEN_KEYS, parse_when, when_names};
use crate::logic::keybindings::{KeybindingCommand, key_label_for};

/// The scope that applies an edit to this computer and every one that is online.
pub const ALL: &str = "all";

/// Whether Settings draws and records keys the Mac way (`⇧⌘D`, `mod` is Cmd).
pub const IS_MAC: bool = cfg!(target_os = "macos");

pub const WHEN_PLACEHOLDER: &str = "Always (e.g. !terminalFocus && chatView)";
pub const WHEN_INVALID: &str = "Use names with !, &&, || and parentheses.";
pub const CONDITIONS_DESCRIPTION: &str = "Adds When to each keybinding, to run a key only in some places (for example not in a Terminal).";
pub const RESET_ALL_PROMPT: &str = "Put every key back to its default";

/// An edit: for each command named, the rules it ends up with (the host replaces them, adding them last).
pub type Edit = Vec<(String, Vec<RuleDraft>)>;

/// The key being recorded: a rule of a command, or a new one (`index` none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recording {
    pub command: String,
    pub index: Option<usize>,
}

/// A recorded key waiting on the user: it needs a modifier, or other commands already have it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub recording: Recording,
    pub key: String,
    pub conflicts: Vec<String>,
    pub error: Option<String>,
}

/// What a key press does while a key is being recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Captured {
    /// Escape: stop recording.
    Cancel,
    /// Backspace or Delete on a rule: take the key off.
    Remove,
    /// A lone modifier or a key with no name: keep listening.
    Ignore,
    /// A key nothing else has: put it on the rule.
    Save(String),
    /// A key that needs the user: too bare, or another command has it.
    Ask(Pending),
}

/// A command's rules, as a key and an optional condition each.
pub fn own(rules: &[KeybindingRule], command: &str) -> Vec<RuleDraft> {
    rules
        .iter()
        .filter(|rule| rule.command == command)
        .map(|rule| RuleDraft { key: rule.key.clone(), when: rule.when.clone().filter(|when| !when.is_empty()) })
        .collect()
}

/// How a key string reads in Settings (`⇧⌘D`), or the string itself when it is not a key.
pub fn label(key: &str) -> String {
    let text = key_label_for(key, IS_MAC).unwrap_or_else(|| key.to_string());
    // A named key (Space, Esc, F5) is one keycap: set it off from the modifier glyphs so the keycaps do not split it.
    let glyphs = text.chars().take_while(|c| "⌃⌥⇧⌘".contains(*c)).map(char::len_utf8).sum::<usize>();
    let (modifiers, rest) = text.split_at(glyphs);
    if glyphs > 0 && rest.chars().count() > 1 && rest.chars().all(|c| c.is_ascii_alphanumeric()) {
        format!("{modifiers} {rest}")
    } else {
        text
    }
}

/// A command's title, or its id for one this build does not know.
pub fn title(command: &str) -> String {
    keybinding_command(command).map_or_else(|| command.to_string(), |command| command.title.to_string())
}

/// The DOM-shaped event a GPUI key press stands for, so the model's key rules apply to it unchanged.
pub fn key_event(keystroke: &Keystroke) -> KeyEvent {
    let key = match keystroke.key.as_str() {
        "left" => "ArrowLeft".to_string(),
        "right" => "ArrowRight".to_string(),
        "up" => "ArrowUp".to_string(),
        "down" => "ArrowDown".to_string(),
        "space" => " ".to_string(),
        "enter" => "Enter".to_string(),
        "escape" => "Escape".to_string(),
        "tab" => "Tab".to_string(),
        "backspace" => "Backspace".to_string(),
        "delete" => "Delete".to_string(),
        "home" => "Home".to_string(),
        "end" => "End".to_string(),
        "pageup" => "PageUp".to_string(),
        "pagedown" => "PageDown".to_string(),
        other if other.len() > 1 && other.starts_with('f') && other[1..].bytes().all(|b| b.is_ascii_digit()) => other.to_uppercase(),
        other => other.to_string(),
    };
    let modifiers = &keystroke.modifiers;
    KeyEvent {
        key,
        code: String::new(),
        meta_key: modifiers.platform,
        ctrl_key: modifiers.control,
        alt_key: modifiers.alt,
        shift_key: modifiers.shift,
    }
}

/// What `event` does while `recording` waits for a key (the keydown handler of `KeybindingsSettings`).
pub fn capture(rules: &[KeybindingRule], recording: &Recording, event: &KeyEvent, mac: bool) -> Captured {
    let plain = !event.meta_key && !event.ctrl_key && !event.alt_key && !event.shift_key;
    if plain && event.key == "Escape" {
        return Captured::Cancel;
    }
    if plain && (event.key == "Backspace" || event.key == "Delete") {
        return if recording.index.is_some() { Captured::Remove } else { Captured::Cancel };
    }
    if is_modifier_event(event) {
        return Captured::Ignore;
    }
    let Some(key) = key_from_event(event, mac) else { return Captured::Ignore };
    let when = recording.index.and_then(|index| own(rules, &recording.command).get(index).and_then(|rule| rule.when.clone()));
    let conflicts = conflicts_for(rules, &key, &recording.command, when.as_deref(), mac);
    if !has_command_modifier(&key) {
        let needed = if mac { "⌘, ⌃ or ⌥" } else { "Ctrl or Alt" };
        let error = format!("{} would run while you type. Add {needed}.", key_label_for(&key, mac).unwrap_or_else(|| key.clone()));
        return Captured::Ask(Pending { recording: recording.clone(), key, conflicts, error: Some(error) });
    }
    if conflicts.is_empty() {
        Captured::Save(key)
    } else {
        Captured::Ask(Pending { recording: recording.clone(), key, conflicts, error: None })
    }
}

/// The sentence under a row that waits on the user.
pub fn pending_message(pending: &Pending) -> String {
    if let Some(error) = &pending.error {
        return error.clone();
    }
    let names = pending.conflicts.iter().map(|other| format!("“{}”", title(other))).collect::<Vec<_>>().join(", ");
    let them = if pending.conflicts.len() > 1 { "them" } else { "it" };
    format!("{} already runs {names}. Replace takes it from {them}.", label(&pending.key))
}

/// Puts `key` on the recorded rule (a new one when `index` is none or past the end), first taking it from the `take`
/// commands that have it under the same condition.
pub fn save_edit(rules: &[KeybindingRule], recording: &Recording, key: &str, take: &[String], mac: bool) -> Edit {
    let mine = own(rules, &recording.command);
    let next: Vec<RuleDraft> = match recording.index {
        Some(index) if index < mine.len() => mine
            .iter()
            .enumerate()
            .map(|(at, rule)| RuleDraft { key: if at == index { key.to_string() } else { rule.key.clone() }, when: rule.when.clone() })
            .collect(),
        _ => mine.iter().cloned().chain(std::iter::once(RuleDraft::new(key))).collect(),
    };
    let when = recording.index.and_then(|index| mine.get(index)).and_then(|rule| rule.when.clone()).unwrap_or_default();
    let wanted = canonical_key(key, mac);
    let mut edit: Edit = take
        .iter()
        .map(|other| {
            let kept = own(rules, other)
                .into_iter()
                .filter(|rule| rule.when.clone().unwrap_or_default() != when || canonical_key(&rule.key, mac) != wanted)
                .collect();
            (other.clone(), kept)
        })
        .collect();
    edit.push((recording.command.clone(), next));
    edit
}

/// The rule at `index` taken off its command.
pub fn remove_edit(rules: &[KeybindingRule], command: &str, index: usize) -> Edit {
    let kept = own(rules, command).into_iter().enumerate().filter(|(at, _)| *at != index).map(|(_, rule)| rule).collect();
    vec![(command.to_string(), kept)]
}

/// The rule at `index` with `when` as its condition (an empty one clears it).
pub fn when_edit(rules: &[KeybindingRule], command: &str, index: usize, when: &str) -> Edit {
    let next = own(rules, command)
        .into_iter()
        .enumerate()
        .map(|(at, rule)| {
            if at != index {
                rule
            } else {
                RuleDraft { key: rule.key, when: Some(when.trim().to_string()).filter(|when| !when.is_empty()) }
            }
        })
        .collect();
    vec![(command.to_string(), next)]
}

/// The command's default keys, without conditions.
pub fn reset_edit(command: &str) -> Edit {
    vec![(command.to_string(), default_rules_for(command).iter().map(|rule| RuleDraft::new(&rule.key)).collect())]
}

/// `rules` after the host has applied `edit`.
pub fn apply_edit(rules: &[KeybindingRule], edit: &Edit) -> Vec<KeybindingRule> {
    edit.iter().fold(rules.to_vec(), |rules, (command, next)| with_command_rules(&rules, command, next))
}

/// Whether the search words all appear in the command's title, id, group or the labels, keys and conditions it has.
pub fn matches(command: &KeybindingCommand, rules: &[KeybindingRule], query: &str, mac: bool) -> bool {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
    if words.is_empty() {
        return true;
    }
    let keys: Vec<String> = own(rules, command.id)
        .iter()
        .map(|rule| {
            format!(
                "{} {} {}",
                key_label_for(&rule.key, mac).unwrap_or_else(|| rule.key.clone()),
                rule.key,
                rule.when.clone().unwrap_or_default()
            )
        })
        .collect();
    let text = format!("{} {} {} {}", command.title, command.id, command.group.title(), keys.join(" ")).to_lowercase();
    words.iter().all(|word| text.contains(word))
}

/// What the field under a condition says about it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WhenCheck {
    /// Text that does not read as an expression.
    pub invalid: bool,
    /// Names in it that no context ever sets.
    pub unknown: Vec<String>,
}

pub fn when_check(text: &str) -> WhenCheck {
    if text.trim().is_empty() {
        return WhenCheck::default();
    }
    match parse_when(text) {
        None => WhenCheck { invalid: true, unknown: Vec::new() },
        Some(tree) => {
            let mut unknown: Vec<String> = Vec::new();
            for name in when_names(&tree) {
                if !WHEN_KEYS.iter().any(|(known, _)| *known == name) && !unknown.iter().any(|seen| seen == name) {
                    unknown.push(name.to_string());
                }
            }
            WhenCheck { invalid: false, unknown }
        }
    }
}

/// "x is never true. Known: a, b." under a condition naming a context no one sets.
pub fn unknown_message(unknown: &[String]) -> String {
    let known = WHEN_KEYS.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ");
    format!("{} {} never true. Known: {known}.", unknown.join(", "), if unknown.len() > 1 { "are" } else { "is" })
}
