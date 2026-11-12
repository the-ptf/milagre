//! GPUI keystrokes as the wire's key events (`Input.dispatchKeyEvent` once the host has them). Printable keys carry
//! `text`, so a key down types; named keys carry their DOM `key`, `code` and Windows key code, which is what pages
//! read. ⌘A, ⌘C, ⌘X, ⌘V, ⌘Z and ⇧⌘Z carry editing `commands`, as `browser-receiver.mjs` sends them, because a
//! headless page has no menu to run them.
//!
//! IME composition (marked text) is not mapped: it needs an `EntityInputHandler` on the stage forwarding
//! `Input.imeSetComposition` and `Input.insertText` (`BROWSER-EXPLORATION.md`).

use gpui::{Keystroke, Modifiers};

use super::bridge::BrowserInput;

/// CDP's modifier bits.
pub fn modifiers(modifiers: &Modifiers) -> u32 {
    (modifiers.alt as u32) | (modifiers.control as u32) << 1 | (modifiers.platform as u32) << 2 | (modifiers.shift as u32) << 3
}

/// DOM `key`, `code` and Windows key code of a named GPUI key.
fn named(key: &str) -> Option<(&'static str, &'static str, u32)> {
    Some(match key {
        "enter" => ("Enter", "Enter", 13),
        "backspace" => ("Backspace", "Backspace", 8),
        "tab" => ("Tab", "Tab", 9),
        "escape" => ("Escape", "Escape", 27),
        "delete" => ("Delete", "Delete", 46),
        "left" => ("ArrowLeft", "ArrowLeft", 37),
        "up" => ("ArrowUp", "ArrowUp", 38),
        "right" => ("ArrowRight", "ArrowRight", 39),
        "down" => ("ArrowDown", "ArrowDown", 40),
        "home" => ("Home", "Home", 36),
        "end" => ("End", "End", 35),
        "pageup" => ("PageUp", "PageUp", 33),
        "pagedown" => ("PageDown", "PageDown", 34),
        _ => return None,
    })
}

/// The editing command ⌘<key> runs in a page.
fn command(key: &str, shift: bool) -> Option<&'static str> {
    Some(match (key, shift) {
        ("a", false) => "selectAll",
        ("c", false) => "copy",
        ("x", false) => "cut",
        ("v", false) => "paste",
        ("z", false) => "undo",
        ("z", true) => "redo",
        _ => return None,
    })
}

/// The key event for `keystroke` going `down` or up, or `None` for a key the page should not get (a bare modifier,
/// a ⌘ shortcut that is not an editing command: those stay the app's).
pub fn key_event(keystroke: &Keystroke, down: bool) -> Option<BrowserInput> {
    let bits = modifiers(&keystroke.modifiers);
    let key = keystroke.key.as_str();
    if let Some((dom_key, code, key_code)) = named(key) {
        let text = (down && key == "enter").then(|| "\r".to_owned());
        return Some(BrowserInput::Key { down, key: dom_key.into(), code: code.into(), key_code, text, modifiers: bits, commands: vec![] });
    }
    if keystroke.modifiers.platform {
        let command = command(key, keystroke.modifiers.shift)?;
        let upper = key.to_ascii_uppercase();
        let key_code = upper.chars().next().map_or(0, |c| c as u32);
        let commands = if down { vec![command] } else { vec![] };
        return Some(BrowserInput::Key {
            down,
            key: key.into(),
            code: format!("Key{upper}"),
            key_code,
            text: None,
            modifiers: bits,
            commands,
        });
    }
    if keystroke.modifiers.control {
        return None;
    }
    // Printable: what the key types (GPUI's `key_char`, with Shift and Option applied), else the key itself.
    let text = match (&keystroke.key_char, key) {
        (Some(typed), _) => typed.clone(),
        (None, "space") => " ".into(),
        (None, key) if key.chars().count() == 1 => key.into(),
        _ => return None,
    };
    let first = text.chars().next()?;
    let (code, key_code) = if first.is_ascii_alphabetic() {
        (format!("Key{}", first.to_ascii_uppercase()), first.to_ascii_uppercase() as u32)
    } else if first.is_ascii_digit() {
        (format!("Digit{first}"), first as u32)
    } else if first == ' ' {
        ("Space".into(), 32)
    } else {
        (String::new(), 0)
    };
    Some(BrowserInput::Key { down, key: text.clone(), code, key_code, text: down.then_some(text), modifiers: bits, commands: vec![] })
}
