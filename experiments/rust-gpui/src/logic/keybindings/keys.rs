//! Key strings such as `mod+shift+d`: parsing, canonical form, labels and keyboard events.

use super::{is_js_space, utf16_len};

const MAX_KEY_LENGTH: usize = 64;

/// A key string read into its parts. `mod` is Cmd on a Mac and Ctrl elsewhere.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyShortcut {
    pub key: String,
    pub mod_key: bool,
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Clone, Copy)]
enum Modifier {
    Mod,
    Meta,
    Ctrl,
    Alt,
    Shift,
}

fn modifier_alias(part: &str) -> Option<Modifier> {
    Some(match part {
        "mod" => Modifier::Mod,
        "cmd" | "command" | "meta" | "super" => Modifier::Meta,
        "ctrl" | "control" => Modifier::Ctrl,
        "alt" | "option" | "opt" => Modifier::Alt,
        "shift" => Modifier::Shift,
        _ => return None,
    })
}

fn key_alias(part: &str) -> &str {
    match part {
        "left" => "arrowleft",
        "right" => "arrowright",
        "up" => "arrowup",
        "down" => "arrowdown",
        "esc" => "escape",
        "return" => "enter",
        "del" => "delete",
        "plus" => "+",
        "comma" => ",",
        "period" => ".",
        " " => "space",
        other => other,
    }
}

fn is_named_key(key: &str) -> bool {
    if matches!(
        key,
        "arrowleft"
            | "arrowright"
            | "arrowup"
            | "arrowdown"
            | "enter"
            | "escape"
            | "tab"
            | "space"
            | "backspace"
            | "delete"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
    ) {
        return true;
    }
    // f1 to f19, no sign and no leading zero.
    key.strip_prefix('f')
        .filter(|n| n.bytes().all(|b| b.is_ascii_digit()) && !n.starts_with('0'))
        .and_then(|n| n.parse::<u32>().ok())
        .is_some_and(|n| (1..=19).contains(&n))
}

/// Whether the key is one UTF-16 unit long (`key.length === 1`).
fn single_unit(key: &str) -> bool {
    utf16_len(key) == 1
}

/// A key string such as `mod+shift+d` read into its parts, or `None` when it isn't one: it needs exactly one key that
/// isn't a modifier.
pub fn parse_key(value: &str) -> Option<KeyShortcut> {
    let text = value.trim_matches(is_js_space).to_lowercase();
    if text.is_empty() || utf16_len(&text) > MAX_KEY_LENGTH {
        return None;
    }
    // "mod++" binds the plus key: the last part may be "+" itself.
    let parts: Vec<&str> = match text.strip_suffix("++") {
        Some(head) => head.split('+').chain(std::iter::once("+")).collect(),
        None => text.split('+').collect(),
    };
    let mut shortcut = KeyShortcut::default();
    for (index, raw) in parts.iter().enumerate() {
        let part = raw.trim_matches(is_js_space);
        let last = index == parts.len() - 1;
        if let Some(modifier) = modifier_alias(part)
            && !last
        {
            match modifier {
                Modifier::Mod => shortcut.mod_key = true,
                Modifier::Meta => shortcut.meta = true,
                Modifier::Ctrl => shortcut.ctrl = true,
                Modifier::Alt => shortcut.alt = true,
                Modifier::Shift => shortcut.shift = true,
            }
            continue;
        }
        if !last || part.is_empty() {
            return None;
        }
        let key = key_alias(part);
        if !single_unit(key) && !is_named_key(key) {
            return None;
        }
        shortcut.key = key.to_string();
    }
    (!shortcut.key.is_empty()).then_some(shortcut)
}

/// The key string for parts, in the order `mod+cmd+ctrl+alt+shift+key`.
pub fn format_key(shortcut: &KeyShortcut) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if shortcut.mod_key {
        parts.push("mod");
    }
    if shortcut.meta {
        parts.push("cmd");
    }
    if shortcut.ctrl {
        parts.push("ctrl");
    }
    if shortcut.alt {
        parts.push("alt");
    }
    if shortcut.shift {
        parts.push("shift");
    }
    parts.push(&shortcut.key);
    parts.join("+")
}

/// Whether the shortcut needs Cmd / Ctrl on this platform: `mod` resolved.
pub(crate) fn resolved_meta_ctrl(shortcut: &KeyShortcut, mac: bool) -> (bool, bool) {
    (shortcut.meta || (mac && shortcut.mod_key), shortcut.ctrl || (!mac && shortcut.mod_key))
}

/// The same key string every way it can be written (`cmd+K` and `mod+k` on a Mac), for comparing two rules.
pub fn canonical_key(value: &str, mac: bool) -> Option<String> {
    let shortcut = parse_key(value)?;
    let (meta, ctrl) = resolved_meta_ctrl(&shortcut, mac);
    Some(format_key(&KeyShortcut { key: shortcut.key, mod_key: false, meta, ctrl, alt: shortcut.alt, shift: shortcut.shift }))
}

/// A keyboard event, the fields the TS reads of a DOM `KeyboardEvent`. For GPUI, build it from a `Keystroke`: `key`
/// is the typed character or the key name, `code` may stay empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: String,
    pub code: String,
    pub meta_key: bool,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub shift_key: bool,
}

fn code_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Minus" => "-",
        "Equal" => "=",
        "Backquote" => "`",
        "Space" => "space",
        _ => return None,
    })
}

/// The key a keyboard event pressed, in key-string form. Letters and digits come from `key`, so they follow the keyboard
/// layout; with Alt or Shift held the Mac types another character, so punctuation and those come from the physical `code`.
pub fn event_key(event: &KeyEvent) -> Option<String> {
    let lower = event.key.to_lowercase();
    if lower.len() == 1 && lower.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return Some(lower);
    }
    let code = event.code.as_str();
    if let Some(rest) = code.strip_prefix("Key").or_else(|| code.strip_prefix("Digit")) {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            let letter_ok = code.starts_with("Key") && c.is_ascii_uppercase();
            let digit_ok = code.starts_with("Digit") && c.is_ascii_digit();
            if letter_ok || digit_ok {
                return Some(c.to_ascii_lowercase().to_string());
            }
        }
    }
    if let Some(key) = code_key(code) {
        return Some(key.to_string());
    }
    if event.key == " " {
        return Some("space".to_string());
    }
    if is_named_key(&lower) {
        return Some(lower);
    }
    single_unit(&event.key).then_some(lower)
}

/// Whether a keyboard event is a modifier on its own (nothing to bind yet).
pub fn is_modifier_event(event: &KeyEvent) -> bool {
    matches!(event.key.as_str(), "Meta" | "Control" | "Alt" | "Shift" | "OS" | "Hyper" | "Super" | "CapsLock" | "Fn")
}

/// The key string a keyboard event pressed, `mod` standing for Cmd on a Mac and Ctrl elsewhere; `None` for a lone modifier.
pub fn key_from_event(event: &KeyEvent, mac: bool) -> Option<String> {
    if is_modifier_event(event) {
        return None;
    }
    let key = event_key(event)?;
    Some(format_key(&KeyShortcut {
        key,
        mod_key: if mac { event.meta_key } else { event.ctrl_key },
        meta: if mac { false } else { event.meta_key },
        ctrl: if mac { event.ctrl_key } else { false },
        alt: event.alt_key,
        shift: event.shift_key,
    }))
}

/// Whether a keyboard event presses the shortcut, with exactly its modifiers. `either` lets `mod` be Cmd or Ctrl on any
/// platform, as the window's shortcuts always took them; an explicit `cmd` or `ctrl` still needs that key.
pub fn event_matches(event: &KeyEvent, shortcut: &KeyShortcut, mac: bool, either: bool) -> bool {
    if event_key(event).as_deref() != Some(shortcut.key.as_str()) {
        return false;
    }
    if event.alt_key != shortcut.alt || event.shift_key != shortcut.shift {
        return false;
    }
    if either && shortcut.mod_key && !shortcut.meta && !shortcut.ctrl {
        return event.meta_key != event.ctrl_key;
    }
    let (meta, ctrl) = resolved_meta_ctrl(shortcut, mac);
    event.meta_key == meta && event.ctrl_key == ctrl
}

/// Whether a key string has Cmd, Ctrl or Alt, or is a function key: a bare letter would fire while typing.
pub fn has_command_modifier(value: &str) -> bool {
    let Some(shortcut) = parse_key(value) else { return false };
    let function_key = shortcut.key.strip_prefix('f').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    shortcut.mod_key || shortcut.meta || shortcut.ctrl || shortcut.alt || function_key
}

fn key_label(key: &str) -> String {
    match key {
        "arrowleft" => "←".into(),
        "arrowright" => "→".into(),
        "arrowup" => "↑".into(),
        "arrowdown" => "↓".into(),
        "enter" => "↵".into(),
        "escape" => "Esc".into(),
        "tab" => "Tab".into(),
        "space" => "Space".into(),
        "backspace" => "⌫".into(),
        "delete" => "Del".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" => "PgUp".into(),
        "pagedown" => "PgDn".into(),
        other => other.to_uppercase(),
    }
}

/// How a key string reads, the way the app's hints draw it: `⇧⌘D` on a Mac (macOS menu order: ⌃⌥⇧⌘, then the key),
/// `Ctrl+Shift+D` elsewhere. `None` for a string that isn't a key.
pub fn key_label_for(value: &str, mac: bool) -> Option<String> {
    let shortcut = parse_key(value)?;
    let (meta, ctrl) = resolved_meta_ctrl(&shortcut, mac);
    let key = key_label(&shortcut.key);
    if mac {
        return Some(format!(
            "{}{}{}{}{key}",
            if ctrl { "⌃" } else { "" },
            if shortcut.alt { "⌥" } else { "" },
            if shortcut.shift { "⇧" } else { "" },
            if meta { "⌘" } else { "" },
        ));
    }
    let mut parts: Vec<String> = Vec::new();
    if ctrl {
        parts.push("Ctrl".into());
    }
    if meta {
        parts.push("Meta".into());
    }
    if shortcut.alt {
        parts.push("Alt".into());
    }
    if shortcut.shift {
        parts.push("Shift".into());
    }
    parts.push(key);
    Some(parts.join("+"))
}
