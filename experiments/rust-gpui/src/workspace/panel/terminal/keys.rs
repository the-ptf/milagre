//! What a key pressed in a Terminal sends to the program in front: xterm's encoding for named keys (arrows, Home,
//! End, Page Up and Down, Insert, Delete, F1 to F12, with the `1;<mods>` parameter when Shift, Alt or Ctrl is held),
//! Ctrl combinations as C0 control bytes, and Alt as Meta (an ESC before the key) when [`KeyOptions`] asks for it.
//!
//! ⌘ shortcuts belong to the app on macOS (`lib/terminal-keys.ts`): [`encode`] returns `None` for them, and for a
//! key it does not know, so the window's own bindings still run.

use alacritty_terminal::term::TermMode;
use gpui::Keystroke;

/// Where a key goes (`TerminalKey` in `lib/terminal-keys.ts`, macOS branch).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyRoute {
    /// Bytes for the PTY.
    Shell(Vec<u8>),
    /// The app's: a ⌘ shortcut, or a key with nothing to send (a lone modifier).
    App,
}

/// Options that change the encoding. The default leaves Option composing characters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyOptions {
    /// Option sends ESC + the key instead of the character macOS composes (`macOptionIsMeta`). Off, as in the
    /// desktop's xterm: Option types characters (`@`, `€`, accents), and Esc-then-key still works as Meta.
    pub option_as_meta: bool,
}

/// The routing and bytes for `keystroke` while the terminal is in `mode` (application cursor keys change the
/// arrows, Home and End).
pub fn encode(keystroke: &Keystroke, mode: TermMode, options: KeyOptions) -> KeyRoute {
    let m = keystroke.modifiers;
    if m.platform {
        return KeyRoute::App;
    }
    let key = keystroke.key.as_str();
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    // xterm's modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
    let param = 1 + u8::from(m.shift) + 2 * u8::from(m.alt) + 4 * u8::from(m.control);
    let modified = param > 1;

    let csi_letter = |letter: char| -> Vec<u8> {
        if modified {
            format!("\x1b[1;{param}{letter}").into_bytes()
        } else if app_cursor {
            format!("\x1bO{letter}").into_bytes()
        } else {
            format!("\x1b[{letter}").into_bytes()
        }
    };
    let ss3_letter = |letter: char| -> Vec<u8> {
        if modified { format!("\x1b[1;{param}{letter}").into_bytes() } else { format!("\x1bO{letter}").into_bytes() }
    };
    let tilde = |code: u8| -> Vec<u8> {
        if modified { format!("\x1b[{code};{param}~").into_bytes() } else { format!("\x1b[{code}~").into_bytes() }
    };
    let meta = |bytes: Vec<u8>| -> Vec<u8> {
        if m.alt {
            let mut out = vec![0x1b];
            out.extend(bytes);
            out
        } else {
            bytes
        }
    };

    // xterm.js on macOS with Option not as Meta: Option+Left and Right move by word as Terminal.app does (ESC b, ESC f).
    let word_jump = m.alt && !m.shift && !m.control && !options.option_as_meta;
    let bytes = match key {
        "left" if word_jump => b"\x1bb".to_vec(),
        "right" if word_jump => b"\x1bf".to_vec(),
        "up" => csi_letter('A'),
        "down" => csi_letter('B'),
        "right" => csi_letter('C'),
        "left" => csi_letter('D'),
        "home" => csi_letter('H'),
        "end" => csi_letter('F'),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "insert" => tilde(2),
        "delete" => tilde(3),
        "f1" => ss3_letter('P'),
        "f2" => ss3_letter('Q'),
        "f3" => ss3_letter('R'),
        "f4" => ss3_letter('S'),
        "f5" => tilde(15),
        "f6" => tilde(17),
        "f7" => tilde(18),
        "f8" => tilde(19),
        "f9" => tilde(20),
        "f10" => tilde(21),
        "f11" => tilde(23),
        "f12" => tilde(24),
        "enter" => meta(b"\r".to_vec()),
        "escape" => meta(b"\x1b".to_vec()),
        "tab" if m.shift => b"\x1b[Z".to_vec(),
        "tab" => meta(b"\t".to_vec()),
        "backspace" if m.control => meta(vec![0x08]),
        "backspace" => meta(vec![0x7f]),
        "space" if m.control => meta(vec![0x00]),
        "space" => meta(b" ".to_vec()),
        _ => return printable(keystroke, options),
    };
    KeyRoute::Shell(bytes)
}

/// A key that types: Ctrl turns it into a control byte, Alt (as Meta) puts ESC before it, otherwise the character
/// macOS composed.
fn printable(keystroke: &Keystroke, options: KeyOptions) -> KeyRoute {
    let m = keystroke.modifiers;
    let key = keystroke.key.as_str();
    let mut chars = key.chars();
    let (Some(first), None) = (chars.next(), chars.next()) else {
        // A lone modifier, a media key: nothing to send. Composed text with no key (rare) still types.
        return match &keystroke.key_char {
            Some(text) if !m.control && !m.alt => KeyRoute::Shell(text.clone().into_bytes()),
            _ => KeyRoute::App,
        };
    };
    if m.control {
        let Some(byte) = control_byte(first, m.shift) else {
            return KeyRoute::App;
        };
        return KeyRoute::Shell(if m.alt { vec![0x1b, byte] } else { vec![byte] });
    }
    if m.alt && options.option_as_meta {
        // The key as Shift alone would type it: Option+Shift+a is ESC A.
        let base = if m.shift { first.to_uppercase().collect::<String>() } else { first.to_string() };
        let mut out = vec![0x1b];
        out.extend(base.into_bytes());
        return KeyRoute::Shell(out);
    }
    match &keystroke.key_char {
        Some(text) => KeyRoute::Shell(text.clone().into_bytes()),
        None if m.shift => KeyRoute::Shell(first.to_uppercase().collect::<String>().into_bytes()),
        None => KeyRoute::Shell(first.to_string().into_bytes()),
    }
}

/// The C0 byte xterm sends for Ctrl with `key`: letters and `@[\]^_` map to 0x00 to 0x1f, the digits 2 to 8 to their
/// VT220 equivalents, `/` to 0x1f and `?` to DEL.
pub fn control_byte(key: char, shift: bool) -> Option<u8> {
    let key = key.to_ascii_lowercase();
    Some(match key {
        'a'..='z' => key as u8 - b'a' + 1,
        '@' | '2' | ' ' => 0x00,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '7' | '/' => 0x1f,
        '-' if shift => 0x1f,
        '8' | '?' => 0x7f,
        _ => return None,
    })
}

/// What a paste sends: bracketed when the program asked for it (with any ESC taken out, so pasted text cannot end
/// the bracket early), and with newlines as carriage returns, as a typed Enter would send.
pub fn paste_bytes(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let clean = text.replace('\x1b', "");
        format!("\x1b[200~{clean}\x1b[201~").into_bytes()
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

/// The arrows a wheel step sends to a full-screen program (alternate screen with alternate scroll): `lines` up when
/// positive, down when negative.
pub fn scroll_arrows(lines: i32, mode: TermMode) -> Vec<u8> {
    let app = mode.contains(TermMode::APP_CURSOR);
    let letter = if lines > 0 { 'A' } else { 'B' };
    let one = if app { format!("\x1bO{letter}") } else { format!("\x1b[{letter}") };
    one.repeat(lines.unsigned_abs() as usize).into_bytes()
}
