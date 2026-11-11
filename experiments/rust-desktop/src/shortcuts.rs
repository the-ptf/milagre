//! Window-scoped key forwarding across WKWebView frames. The production shared
//! keybinding compiler supplies the rule list; Rust neither owns defaults nor `when`.
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, PartialEq)]
struct Shortcut {
    key: String,
    meta: bool,
    control: bool,
    alt: bool,
    shift: bool,
}
struct State(Arc<RwLock<Vec<Shortcut>>>);

fn parse_rules(value: &Value) -> Result<Vec<Shortcut>, Value> {
    let invalid = || json!({"code":"SHORTCUT_ERROR","message":"Invalid forwarded shortcut rules."});
    let values = value
        .as_array()
        .filter(|values| values.len() <= 256)
        .ok_or_else(invalid)?;
    values
        .iter()
        .map(|value| {
            let key = value["key"]
                .as_str()
                .filter(|key| !key.is_empty() && key.len() <= 64)
                .ok_or_else(invalid)?;
            let boolean = |name: &str| value[name].as_bool().ok_or_else(invalid);
            Ok(Shortcut {
                key: key.to_owned(),
                meta: boolean("meta")?,
                control: boolean("control")?,
                alt: boolean("alt")?,
                shift: boolean("shift")?,
            })
        })
        .collect()
}

pub fn set(app: &AppHandle, value: &Value) -> Result<Value, Value> {
    let rules = parse_rules(value)?;
    let state = app.try_state::<State>().ok_or_else(
        || json!({"code":"SHORTCUT_ERROR","message":"Native shortcuts are unavailable."}),
    )?;
    *state.0.write().map_err(
        |_| json!({"code":"SHORTCUT_ERROR","message":"Native shortcuts are unavailable."}),
    )? = rules;
    Ok(Value::Null)
}

// macOS virtual key codes are layout-independent. Letters reported by the event
// itself win; physical codes supply punctuation and keys altered by Option/Shift,
// matching shared/keybindings.mjs eventKey().
fn physical_key(code: u16) -> (&'static str, &'static str) {
    match code {
        0 => ("KeyA", "a"),
        1 => ("KeyS", "s"),
        2 => ("KeyD", "d"),
        3 => ("KeyF", "f"),
        4 => ("KeyH", "h"),
        5 => ("KeyG", "g"),
        6 => ("KeyZ", "z"),
        7 => ("KeyX", "x"),
        8 => ("KeyC", "c"),
        9 => ("KeyV", "v"),
        11 => ("KeyB", "b"),
        12 => ("KeyQ", "q"),
        13 => ("KeyW", "w"),
        14 => ("KeyE", "e"),
        15 => ("KeyR", "r"),
        16 => ("KeyY", "y"),
        17 => ("KeyT", "t"),
        18 => ("Digit1", "1"),
        19 => ("Digit2", "2"),
        20 => ("Digit3", "3"),
        21 => ("Digit4", "4"),
        22 => ("Digit6", "6"),
        23 => ("Digit5", "5"),
        24 => ("Equal", "="),
        25 => ("Digit9", "9"),
        26 => ("Digit7", "7"),
        27 => ("Minus", "-"),
        28 => ("Digit8", "8"),
        29 => ("Digit0", "0"),
        30 => ("BracketRight", "]"),
        31 => ("KeyO", "o"),
        32 => ("KeyU", "u"),
        33 => ("BracketLeft", "["),
        34 => ("KeyI", "i"),
        35 => ("KeyP", "p"),
        36 => ("Enter", "enter"),
        37 => ("KeyL", "l"),
        38 => ("KeyJ", "j"),
        39 => ("Quote", "'"),
        40 => ("KeyK", "k"),
        41 => ("Semicolon", ";"),
        42 => ("Backslash", "\\"),
        43 => ("Comma", ","),
        44 => ("Slash", "/"),
        45 => ("KeyN", "n"),
        46 => ("KeyM", "m"),
        47 => ("Period", "."),
        48 => ("Tab", "tab"),
        49 => ("Space", "space"),
        50 => ("Backquote", "`"),
        51 => ("Backspace", "backspace"),
        53 => ("Escape", "escape"),
        64 => ("F17", "f17"),
        76 => ("NumpadEnter", "enter"),
        79 => ("F18", "f18"),
        80 => ("F19", "f19"),
        96 => ("F5", "f5"),
        97 => ("F6", "f6"),
        98 => ("F7", "f7"),
        99 => ("F3", "f3"),
        100 => ("F8", "f8"),
        101 => ("F9", "f9"),
        103 => ("F11", "f11"),
        105 => ("F13", "f13"),
        106 => ("F16", "f16"),
        107 => ("F14", "f14"),
        109 => ("F10", "f10"),
        111 => ("F12", "f12"),
        113 => ("F15", "f15"),
        115 => ("Home", "home"),
        116 => ("PageUp", "pageup"),
        117 => ("Delete", "delete"),
        118 => ("F4", "f4"),
        119 => ("End", "end"),
        120 => ("F2", "f2"),
        121 => ("PageDown", "pagedown"),
        122 => ("F1", "f1"),
        123 => ("ArrowLeft", "arrowleft"),
        124 => ("ArrowRight", "arrowright"),
        125 => ("ArrowDown", "arrowdown"),
        126 => ("ArrowUp", "arrowup"),
        _ => ("", ""),
    }
}

fn key_parts(code: u16, characters: &str) -> (String, &'static str, String) {
    let (physical, canonical) = physical_key(code);
    let key = if !canonical.is_empty() && canonical.len() > 1 && canonical != "space" {
        if physical == "NumpadEnter" {
            "Enter".to_owned()
        } else {
            physical.to_owned()
        }
    } else {
        characters.to_owned()
    };
    let lower = key.to_lowercase();
    let normalized = if lower.len() == 1 && lower.as_bytes()[0].is_ascii_alphanumeric() {
        lower
    } else if !canonical.is_empty() {
        canonical.to_owned()
    } else if key == " " {
        "space".to_owned()
    } else if key.encode_utf16().count() == 1 {
        lower
    } else {
        String::new()
    };
    (key, physical, normalized)
}

fn matched(
    rules: &[Shortcut],
    key: &str,
    meta: bool,
    control: bool,
    alt: bool,
    shift: bool,
) -> bool {
    // Fixed lifecycle keys always belong to the native menu, even if a user tries
    // to bind a forwarded command to them. Match Electron's before-input order.
    if meta && !alt && !shift && (key == "q" || key == "w") {
        return false;
    }
    rules.iter().any(|rule| {
        rule.key == key
            && rule.meta == meta
            && rule.control == control
            && rule.alt == alt
            && rule.shift == shift
    })
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSWindow};
    use std::cell::RefCell;

    thread_local! { static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) }; }
    if MainThreadMarker::new().is_none() {
        return Err("Install shortcuts on the main thread".into());
    }
    if MONITOR.with(|slot| slot.borrow().is_some()) {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let window_number = unsafe {
        (&*window
            .ns_window()
            .map_err(|error| error.to_string())?
            .cast::<NSWindow>())
            .windowNumber()
    };
    let rules = Arc::new(RwLock::new(Vec::new()));
    app.manage(State(rules.clone()));
    let app = app.clone();
    let handler = RcBlock::new(move |pointer: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        // The local monitor supplies a live event; returning it forwards it unchanged.
        let event = unsafe { pointer.as_ref() };
        if event.windowNumber() != window_number {
            return pointer.as_ptr();
        }
        let flags = event.modifierFlags();
        let meta = flags.contains(NSEventModifierFlags::Command);
        let control = flags.contains(NSEventModifierFlags::Control);
        let alt = flags.contains(NSEventModifierFlags::Option);
        let shift = flags.contains(NSEventModifierFlags::Shift);
        let characters = event
            .characters()
            .map(|text| text.to_string())
            .unwrap_or_default();
        let (key, code, normalized) = key_parts(event.keyCode(), &characters);
        let should_forward = rules
            .read()
            .map(|rules| matched(&rules, &normalized, meta, control, alt, shift))
            .unwrap_or(false);
        if !should_forward {
            return pointer.as_ptr();
        }
        if app.emit("native-event", json!({"channel":"app:shortcut", "payload":{ "key":key, "code":code, "meta":meta, "control":control, "alt":alt, "shift":shift }})).is_ok() {
            std::ptr::null_mut()
        } else { pointer.as_ptr() }
    });
    // The callback returns either the valid incoming NSEvent or nil to consume it.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    }
    .ok_or("Could not install native shortcut monitor")?;
    MONITOR.with(|slot| *slot.borrow_mut() = Some(monitor));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_updates_are_bounded_and_invalid_updates_cannot_replace_existing_rules() {
        assert!(parse_rules(&json!([])).unwrap().is_empty());
        assert!(parse_rules(
            &json!([{"key":"k","meta":true,"control":false,"alt":false,"shift":true}])
        )
        .is_ok());
        assert!(parse_rules(&json!([{"key":"k","meta":true}])).is_err());
        assert!(parse_rules(&json!({})).is_err());
        assert!(parse_rules(&json!(vec![Value::Null; 257])).is_err());
    }

    #[test]
    fn native_keys_conform_to_production_shared_compiler_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../renderer/shortcuts-fixtures.json")).unwrap();
        let rules = parse_rules(&fixture["rules"]).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let (key, code, normalized) = key_parts(
                case["keyCode"].as_u64().unwrap() as u16,
                case["characters"].as_str().unwrap(),
            );
            assert_eq!(key, case["key"].as_str().unwrap());
            assert_eq!(code, case["code"].as_str().unwrap());
            assert_eq!(normalized, case["normalized"].as_str().unwrap());
            assert_eq!(
                matched(
                    &rules,
                    &normalized,
                    case["meta"].as_bool().unwrap(),
                    case["control"].as_bool().unwrap(),
                    case["alt"].as_bool().unwrap(),
                    case["shift"].as_bool().unwrap()
                ),
                case["matched"].as_bool().unwrap(),
                "{case}"
            );
        }
    }
}
