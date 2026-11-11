//! The keybinding model: the command catalogue, key strings, `when` expressions, rules and their merging, and the
//! translation of the effective table into GPUI keystrokes. Pure logic, no UI and no I/O. A port of
//! `packages/shared/src/keybindings.mjs` plus the shortcut gate of `apps/desktop/app/src/lib/keybindings.ts`.
//!
//! Each computer keeps a `keybindings.json` of `{ key, command, when? }` rules (the host reads and writes it; the
//! daemon answers `keybindings:read` with a [`KeybindingsState`]). The last rule whose key and `when` both match
//! wins. [`gpui::gpui_bindings`] turns the effective rules into `(GPUI keystroke, command id)` pairs for a later
//! package to register; nothing here touches GPUI.
//!
//! - [`catalog`]: [`KEYBINDING_COMMANDS`], the 31 commands with their default keys.
//! - [`keys`]: `parseKey`, `formatKey`, `canonicalKey`, `keyLabelFor`, `hasCommandModifier` and the key-event helpers.
//! - [`when`]: `parseWhen`, `evaluateWhen`, `whenNames` and the context keys.
//! - [`rules`]: reading, compiling, matching, conflicts and merging of rules.
//! - [`gpui`]: effective table to GPUI keystroke syntax and key contexts.

pub mod catalog;
pub mod gpui;
pub mod keys;
pub mod rules;
pub mod when;

pub use catalog::{CommandGroup, KEYBINDING_COMMANDS, KeybindingCommand};
pub use gpui::{GpuiBinding, GpuiOptions, gpui_bindings};
pub use keys::{KeyEvent, KeyShortcut, key_label_for, parse_key};
pub use rules::{CompiledRule, KeybindingRule, KeybindingsState, compile_rules, default_keybindings};
pub use when::{WhenContext, WhenNode, evaluate_when, parse_when};

#[cfg(test)]
mod tests;

/// JavaScript's `\s` and `trim` whitespace.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `string.length` in JavaScript.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
