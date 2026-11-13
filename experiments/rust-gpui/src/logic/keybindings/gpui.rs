//! The effective table as GPUI key bindings: `(keystroke, command id)` pairs with a key-context predicate. Nothing is
//! registered here; a later package turns each [`GpuiBinding`] into a `KeyBinding` (one action per command id).
//!
//! The mapping:
//! - A key string becomes a GPUI keystroke: `mod+shift+d` is `shift-cmd-d` on a Mac and `ctrl-shift-d` elsewhere,
//!   `cmd` is `cmd` on a Mac and `super` elsewhere, `alt+space` is `alt-space`, `mod+alt+arrowleft` is `alt-cmd-left`.
//!   The minus key is written `cmd--`, as GPUI parses it.
//! - A rule's `when` becomes a GPUI key-context predicate (`chatView && !(terminalFocus || editableFocus)`), written
//!   with explicit parentheses. The names are context keys the window sets on the focused element's context
//!   (`WHEN_KEYS`); a name the context does not hold is false in GPUI too. A `.` in a name becomes `_` (GPUI
//!   identifiers have no dot; such a name is never set, so it stays false).
//! - The desktop's `shortcutCommand` gate: a command whose last rule has no Cmd, Ctrl, Alt or function key never runs
//!   while a field has the keyboard. That is the predicate `!editableFocus` added to every binding of that command.
//! - Order is precedence: GPUI lets a binding added later win over one added earlier at the same context depth, which
//!   is the TS's "last matching rule wins". Register the pairs in the order returned. GPUI also prefers a deeper
//!   context path over a later binding; predicates built only from names set on one element have no path, so
//!   this does not apply here.
//! - `mod_either` (the window's habit of letting `mod` be Cmd or Ctrl on any platform): for each `mod` rule an extra
//!   binding with the other modifier is emitted, all of them BEFORE the exact bindings, so an exact rule for that
//!   key always beats them, as in `commandForEvent`'s two passes.

use super::keys::{KeyShortcut, has_command_modifier, resolved_meta_ctrl};
use super::rules::{CompiledRule, KeybindingRule, compile_rules};
use super::when::WhenNode;
use std::collections::HashMap;

/// One key binding for GPUI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuiBinding {
    /// GPUI keystroke syntax, e.g. `shift-cmd-d`.
    pub keystroke: String,
    /// The command id, e.g. `changes.toggle`.
    pub command: String,
    /// GPUI key-context predicate, or `None` for a binding that applies everywhere.
    pub context: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GpuiOptions {
    /// Also bind `mod` rules to the other platform modifier (Ctrl on a Mac, Cmd/Super elsewhere), at lower priority.
    pub mod_either: bool,
}

/// GPUI's name for a key: its keystroke spelling of the TS key name.
fn gpui_key(key: &str) -> &str {
    match key {
        "arrowleft" => "left",
        "arrowright" => "right",
        "arrowup" => "up",
        "arrowdown" => "down",
        other => other,
    }
}

/// The GPUI keystroke for a shortcut on a platform, modifiers in the order ctrl, alt, shift, cmd.
pub fn gpui_keystroke(shortcut: &KeyShortcut, mac: bool) -> String {
    let (meta, ctrl) = resolved_meta_ctrl(shortcut, mac);
    keystroke_from(meta, ctrl, shortcut, mac)
}

fn keystroke_from(meta: bool, ctrl: bool, shortcut: &KeyShortcut, mac: bool) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if ctrl {
        parts.push("ctrl");
    }
    if shortcut.alt {
        parts.push("alt");
    }
    if shortcut.shift {
        parts.push("shift");
    }
    if meta {
        parts.push(if mac { "cmd" } else { "super" });
    }
    parts.push(gpui_key(&shortcut.key));
    parts.join("-")
}

fn predicate(node: &WhenNode) -> String {
    match node {
        WhenNode::Identifier(name) => name.replace('.', "_"),
        WhenNode::Not(inner) => format!("!{}", predicate(inner)),
        WhenNode::And(left, right) => format!("({} && {})", predicate(left), predicate(right)),
        WhenNode::Or(left, right) => format!("({} || {})", predicate(left), predicate(right)),
    }
}

/// A rule's `when` as a GPUI key-context predicate (no outer parentheses).
pub fn gpui_context(node: &WhenNode) -> String {
    let text = predicate(node);
    match node {
        WhenNode::And(..) | WhenNode::Or(..) => text[1..text.len() - 1].to_string(),
        _ => text,
    }
}

fn context_for(rule: &CompiledRule, gated: bool) -> Option<String> {
    let when = rule.when_tree.as_ref().map(gpui_context);
    match (when, gated) {
        (None, false) => None,
        (None, true) => Some("!editableFocus".to_string()),
        (Some(w), false) => Some(w),
        (Some(w), true) => Some(format!("({w}) && !editableFocus")),
    }
}

/// The effective table as GPUI bindings, in registration order. Rules whose key or `when` does not parse are left
/// out, as `compile_rules` does.
pub fn gpui_bindings(rules: &[KeybindingRule], mac: bool, options: GpuiOptions) -> Vec<GpuiBinding> {
    let compiled = compile_rules(rules);
    // The shortcutCommand gate looks at the command's last (compiled) rule.
    let mut gated: HashMap<&str, bool> = HashMap::new();
    for rule in &compiled {
        gated.insert(rule.rule.command.as_str(), !has_command_modifier(&rule.rule.key));
    }
    let mut out = Vec::new();
    if options.mod_either {
        for rule in &compiled {
            let shortcut = &rule.shortcut;
            if shortcut.mod_key && !shortcut.meta && !shortcut.ctrl {
                // The exact binding is Cmd on a Mac and Ctrl elsewhere; the fallback is the other one.
                out.push(GpuiBinding {
                    keystroke: keystroke_from(!mac, mac, shortcut, mac),
                    command: rule.rule.command.clone(),
                    context: context_for(rule, gated[rule.rule.command.as_str()]),
                });
            }
        }
    }
    for rule in &compiled {
        out.push(GpuiBinding {
            keystroke: gpui_keystroke(&rule.shortcut, mac),
            command: rule.rule.command.clone(),
            context: context_for(rule, gated[rule.rule.command.as_str()]),
        });
    }
    out
}

/// Just the `(keystroke, command id)` pairs of [`gpui_bindings`], for a caller that sets contexts itself.
pub fn gpui_pairs(rules: &[KeybindingRule], mac: bool, options: GpuiOptions) -> Vec<(String, String)> {
    gpui_bindings(rules, mac, options).into_iter().map(|b| (b.keystroke, b.command)).collect()
}
