//! Scope and Chat keys, and the computer a key belongs to (`packages/shared/src/chat-scopes.mjs`). A paired
//! computer's keys carry its id in front of what this Mac's keys have: `${computerId}|${path}` for a Project and
//! `milagre-link:${computerId}|${linkId}` for a Link, so code that slices the Link prefix off gets a Link id that
//! still names its computer. `"local"` is this Mac, whose keys carry nothing. **The key format must match the
//! TypeScript exactly.**

use std::fmt;

use crate::logic::marks::Tone;

const PREFIX: &str = "milagre-link:";

/// This Mac, whose keys carry no computer.
pub const LOCAL_COMPUTER: &str = "local";

/// A computer's status dot on both apps (8px, round), as a palette key: green online, orange while it connects or
/// is being checked, red when it refused the pairing, ink4 offline or unknown.
pub fn presence_tone(state: Option<&str>) -> Tone {
    match state {
        Some("online") => Tone::Green,
        Some("connecting" | "reconnecting" | "checking") => Tone::Orange,
        Some("refused") => Tone::Red,
        _ => Tone::Ink4,
    }
}

/// Why a key or id was refused (the message the TypeScript throws).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeError {
    InvalidComputerId,
    InvalidScope,
    InvalidChatId,
    InvalidChatKey,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ScopeError::InvalidComputerId => "Invalid computer id.",
            ScopeError::InvalidScope => "Choose a valid Project or Link.",
            ScopeError::InvalidChatId => "Invalid Chat ID.",
            ScopeError::InvalidChatKey => "Invalid Chat key.",
        })
    }
}

impl std::error::Error for ScopeError {}

/// What a Chat lives in: a Project (by path) or a Link (by id).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Link { link_id: String },
    Project { project_path: String },
}

fn is_computer_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

/// `^[A-Za-z0-9-]{1,64}$`
fn is_computer_id(id: &str) -> bool {
    (1..=64).contains(&id.chars().count()) && id.chars().all(is_computer_id_char)
}

struct Parts<'a> {
    link: bool,
    computer_id: &'a str,
    bare: &'a str,
}

/// Whether a key is a Link's, its computer, and the key without it.
fn parts(key: &str) -> Parts<'_> {
    let link = key.starts_with(PREFIX);
    let rest = if link { &key[PREFIX.len()..] } else { key };
    // `^([A-Za-z0-9-]{1,64})\|`, and `local|` is never a qualifier.
    let run = rest.chars().take_while(|c| is_computer_id_char(*c)).count();
    let qualified = (1..=64).contains(&run) && rest[run..].starts_with('|') && &rest[..run] != LOCAL_COMPUTER;
    if qualified {
        Parts { link, computer_id: &rest[..run], bare: &rest[run + 1..] }
    } else {
        Parts { link, computer_id: LOCAL_COMPUTER, bare: rest }
    }
}

/// The computer a scope or Chat key belongs to; "local" for this Mac's.
pub fn computer_of_key(key: &str) -> &str {
    parts(key).computer_id
}

/// The key as its own computer knows it.
pub fn unqualify_key(key: &str) -> String {
    let Parts { link, bare, .. } = parts(key);
    if link { format!("{PREFIX}{bare}") } else { bare.to_owned() }
}

/// A computer's key as this window keeps it: unchanged for this Mac (`None`, empty or "local"), and for a key that
/// already names a computer. A computer id that isn't `[A-Za-z0-9-]{1,64}` is an error, never this Mac's key.
pub fn qualify_key(computer_id: Option<&str>, key: &str) -> Result<String, ScopeError> {
    let Some(computer_id) = computer_id.filter(|id| !id.is_empty() && *id != LOCAL_COMPUTER) else { return Ok(key.to_owned()) };
    if !is_computer_id(computer_id) {
        return Err(ScopeError::InvalidComputerId);
    }
    let Parts { link, computer_id: current, bare } = parts(key);
    if current != LOCAL_COMPUTER {
        return Ok(key.to_owned());
    }
    Ok(if link { format!("{PREFIX}{computer_id}|{bare}") } else { format!("{computer_id}|{key}") })
}

fn hex_run(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A Link id: a UUID, `8-4-4-4-12` hex digits in either case. The daemon's own check, so strict: a
/// computer-qualified id is not one.
pub fn valid_link_id(id: &str) -> bool {
    let pieces: Vec<&str> = id.split('-').collect();
    pieces.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&pieces).all(|(len, piece)| hex_run(piece, *len))
}

/// Whether a key is a Link's scope key.
pub fn is_link_scope_key(key: &str) -> bool {
    key.starts_with(PREFIX) && valid_link_id(parts(key).bare)
}

/// `/` or a Windows drive (`C:\`, `c:/`).
fn is_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
}

/// The key a scope is stored under: a Project's path as it is, a Link's id behind the `milagre-link:` prefix.
pub fn scope_key(scope: &Scope) -> Result<String, ScopeError> {
    match scope {
        Scope::Link { link_id } if valid_link_id(parts(&format!("{PREFIX}{link_id}")).bare) => Ok(format!("{PREFIX}{link_id}")),
        Scope::Project { project_path } if is_absolute(parts(project_path).bare) => Ok(project_path.clone()),
        _ => Err(ScopeError::InvalidScope),
    }
}

/// The scope a key names.
pub fn scope_from_key(key: &str) -> Scope {
    if is_link_scope_key(key) {
        Scope::Link { link_id: key[PREFIX.len()..].to_owned() }
    } else {
        Scope::Project { project_path: key.to_owned() }
    }
}

/// A Chat's key: its scope's key, `#`, and its id (a safe positive integer).
pub fn chat_key_for_scope(scope: &Scope, session_id: i64) -> Result<String, ScopeError> {
    // `Number.isSafeInteger(id) && id >= 1`
    if !(1..=(1_i64 << 53) - 1).contains(&session_id) {
        return Err(ScopeError::InvalidChatId);
    }
    Ok(format!("{}#{session_id}", scope_key(scope)?))
}

/// The scope a Chat key names; an error for a key that doesn't end in `#` and digits, or whose scope is invalid.
pub fn scope_from_chat_key(key: &str) -> Result<Scope, ScopeError> {
    let hash = key.rfind('#').ok_or(ScopeError::InvalidChatKey)?;
    let tail = &key[hash + 1..];
    if tail.is_empty() || !tail.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ScopeError::InvalidChatKey);
    }
    let scope = scope_from_key(&key[..hash]);
    scope_key(&scope)?;
    Ok(scope)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
    const LINK_ID: &str = "f1713d69-569d-405b-a0b2-19bfdf565a76";

    fn project(path: &str) -> Scope {
        Scope::Project { project_path: path.to_owned() }
    }

    fn link(id: &str) -> Scope {
        Scope::Link { link_id: id.to_owned() }
    }

    fn qualify(computer: &str, key: &str) -> String {
        qualify_key(Some(computer), key).expect("a valid computer id")
    }

    #[test]
    fn presence_dots_by_state() {
        assert_eq!(presence_tone(Some("online")), Tone::Green);
        for state in ["connecting", "reconnecting", "checking"] {
            assert_eq!(presence_tone(Some(state)), Tone::Orange, "{state}");
        }
        assert_eq!(presence_tone(Some("refused")), Tone::Red);
        for state in [Some("offline"), Some(""), Some("Online"), None] {
            assert_eq!(presence_tone(state), Tone::Ink4, "{state:?}");
        }
    }

    #[test]
    fn scope_keys_preserve_project_paths_and_separate_named_link_chats() {
        let my_project = project("/code/my#project");
        assert_eq!(chat_key_for_scope(&my_project, 7).as_deref(), Ok("/code/my#project#7"));
        assert_eq!(scope_from_chat_key("/code/my#project#7"), Ok(my_project));
        let a_link = link(LINK_ID);
        assert_eq!(chat_key_for_scope(&a_link, 7).as_deref(), Ok("milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7"));
        assert_eq!(scope_from_chat_key("milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7"), Ok(a_link.clone()));
        for bad in [0, -1, 1_i64 << 53] {
            assert_eq!(chat_key_for_scope(&a_link, bad), Err(ScopeError::InvalidChatId), "{bad}");
        }
        assert_eq!(chat_key_for_scope(&a_link, (1_i64 << 53) - 1).as_deref().map(|key| key.ends_with("#9007199254740991")), Ok(true));
        assert_eq!(scope_key(&link("../../outside")), Err(ScopeError::InvalidScope));
    }

    #[test]
    fn a_paired_computers_keys_carry_its_id_and_this_macs_keys_are_unchanged() {
        assert_eq!(LOCAL_COMPUTER, "local");
        assert_eq!(qualify("local", "/code/app"), "/code/app");
        assert_eq!(qualify_key(None, "/code/app").as_deref(), Ok("/code/app"));
        assert_eq!(qualify(ID, "/code/app"), format!("{ID}|/code/app"));
        assert_eq!(qualify(ID, &format!("{ID}|/code/app")), format!("{ID}|/code/app"), "never twice");
        assert_eq!(qualify(ID, "/code/app#3"), format!("{ID}|/code/app#3"));
        assert_eq!(qualify(ID, &format!("milagre-link:{LINK_ID}")), format!("milagre-link:{ID}|{LINK_ID}"));
        assert_ne!(qualify(ID, "/code/app"), "/code/app", "the same path on two Macs is two keys");
        for key in [
            "/code/app".to_owned(),
            format!("{ID}|/code/app"),
            format!("milagre-link:{LINK_ID}"),
            format!("milagre-link:{ID}|{LINK_ID}#2"),
            format!("{ID}|/code/my#project#7"),
            "C:\\code\\app".to_owned(),
        ] {
            assert_eq!(qualify(computer_of_key(&key), &unqualify_key(&key)), key, "{key}");
        }
        assert_eq!(computer_of_key("/code/app#3"), "local");
        assert_eq!(computer_of_key(&format!("{ID}|/code/app#3")), ID);
        assert_eq!(computer_of_key(&format!("milagre-link:{ID}|{LINK_ID}#2")), ID);
        assert_eq!(unqualify_key(&format!("milagre-link:{ID}|{LINK_ID}#2")), format!("milagre-link:{LINK_ID}#2"));
        assert!(is_link_scope_key(&format!("milagre-link:{ID}|{LINK_ID}")));
        assert!(!is_link_scope_key(&format!("milagre-link:{ID}|../outside")));
        assert!(!is_link_scope_key(&format!("{ID}|/code/app")));
        assert_eq!(scope_key(&project(&format!("{ID}|/code/app"))), Ok(format!("{ID}|/code/app")));
        assert_eq!(scope_key(&link(&format!("{ID}|{LINK_ID}"))), Ok(format!("milagre-link:{ID}|{LINK_ID}")));
        assert_eq!(scope_key(&project(&format!("{ID}|relative"))), Err(ScopeError::InvalidScope));
        assert_eq!(scope_from_chat_key(&format!("{ID}|/code/app#4")), Ok(project(&format!("{ID}|/code/app"))));
        assert_eq!(scope_from_chat_key(&format!("milagre-link:{ID}|{LINK_ID}#4")), Ok(link(&format!("{ID}|{LINK_ID}"))));
        assert!(!valid_link_id(&format!("{ID}|{LINK_ID}")), "the daemon's own check of a Link id stays strict");
    }

    #[test]
    fn an_invalid_computer_id_is_an_error_and_local_bar_is_never_a_qualifier() {
        for bad in ["a_b", "a.b", "a|b", &"a".repeat(65)] {
            assert_eq!(qualify_key(Some(bad), "/code/app"), Err(ScopeError::InvalidComputerId), "{bad}");
        }
        assert_eq!(qualify_key(Some(""), "/code/app").as_deref(), Ok("/code/app"));
        assert_eq!(computer_of_key("/code/a|b#1"), "local");
        assert_eq!(unqualify_key("/code/a|b#1"), "/code/a|b#1");
        assert_eq!(computer_of_key("local|/x"), "local");
        assert_eq!(unqualify_key("local|/x"), "local|/x");
        assert!(!is_link_scope_key("milagre-link:local|f1713d69-569d-405b-a0b2-19bfdf565a76"));
        // A 64-character id qualifies; a 65-character run is not a qualifier.
        let long = "a".repeat(64);
        assert_eq!(computer_of_key(&format!("{long}|/x")), long);
        let too_long = format!("{}|/x", "a".repeat(65));
        assert_eq!(computer_of_key(&too_long), "local");
    }

    #[test]
    fn chat_keys_need_a_trailing_numeric_id_and_a_valid_scope() {
        for bad in ["/code/app", "/code/app#", "/code/app#12x", "/code/app#-1", "relative#3", "#3", "milagre-link:nope#3"] {
            assert!(scope_from_chat_key(bad).is_err(), "{bad}");
        }
        assert_eq!(scope_from_chat_key("/code/app#x"), Err(ScopeError::InvalidChatKey));
        assert_eq!(scope_from_chat_key("relative#3"), Err(ScopeError::InvalidScope));
        assert_eq!(scope_from_chat_key("C:\\code\\app#3"), Ok(project("C:\\code\\app")));
        assert_eq!(scope_from_key("milagre-link:nope"), project("milagre-link:nope"));
        assert_eq!(scope_from_key(&format!("milagre-link:{LINK_ID}")), link(LINK_ID));
        assert_eq!(ScopeError::InvalidComputerId.to_string(), "Invalid computer id.");
    }

    #[test]
    fn link_ids_are_uuids_in_either_case() {
        assert!(valid_link_id(LINK_ID));
        assert!(valid_link_id(&LINK_ID.to_uppercase()));
        assert!(!valid_link_id("f1713d69-569d-405b-a0b2-19bfdf565a7"));
        assert!(!valid_link_id("g1713d69-569d-405b-a0b2-19bfdf565a76"));
        assert!(!valid_link_id(""));
    }
}
