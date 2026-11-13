//! Port of core/keybindings.cjs and the persistence/validation parts of shared/keybindings.mjs.
//! Keyboard event dispatch remains in the clients. File operations use the profile's confined Files API.
use crate::settings::{failed, Files};
use milagre_owner_store::jsjson;
use milagre_owner_wire::RpcError;
use serde_json::{json, Value};

pub const METHODS: &[&str] = &[
    "keybindings:read",
    "keybindings:set-command",
    "keybindings:reset-command",
    "keybindings:reset",
];
const FILE: &str = "keybindings.json";
const SEEN: &str = "keybindings.seen.json";
const CHANGED: &str = "keybindings:changed";
const COMMANDS: &[(&str, &str)] = &[
    ("commandPalette.toggle", "mod+k"),
    ("chat.new", "mod+n"),
    ("project.add", "mod+o"),
    ("settings.open", "mod+,"),
    ("theme.toggle", "mod+shift+t"),
    ("sidebar.toggle", "mod+b"),
    ("canvas.open", "mod+shift+l"),
    ("usage.open", "mod+shift+u"),
    ("grid.toggle", "mod+shift+m"),
    ("grid.focusPrevious", "mod+alt+arrowleft"),
    ("grid.focusNext", "mod+alt+arrowright"),
    ("chat.parent", "mod+["),
    ("chat.jump.1", "mod+1"),
    ("chat.jump.2", "mod+2"),
    ("chat.jump.3", "mod+3"),
    ("chat.jump.4", "mod+4"),
    ("chat.jump.5", "mod+5"),
    ("chat.jump.6", "mod+6"),
    ("chat.jump.7", "mod+7"),
    ("chat.jump.8", "mod+8"),
    ("chat.jump.9", "mod+9"),
    ("chat.find", "mod+f"),
    ("chat.quote", "mod+shift+'"),
    ("dictation.toggle", "alt+space"),
    ("changes.toggle", "mod+shift+d"),
    ("terminal.toggle", "mod+j"),
    ("terminal.new", "mod+t"),
    ("artifacts.toggle", "mod+shift+a"),
    ("designs.toggle", "mod+shift+e"),
    ("browser.toggle", "mod+shift+b"),
    ("simulator.toggle", "mod+shift+s"),
];
fn defaults() -> Vec<Value> {
    COMMANDS
        .iter()
        .map(|(command, key)| json!({"key":key,"command":command}))
        .collect()
}
fn all_commands() -> Vec<Value> {
    COMMANDS.iter().map(|(command, _)| json!(command)).collect()
}
fn stringify(value: Option<&Value>) -> String {
    value
        .map(jsjson::to_string)
        .unwrap_or_else(|| "undefined".into())
}
fn format_rules(rules: &[Value]) -> String {
    if rules.is_empty() {
        "[]\n".into()
    } else {
        format!(
            "[\n{}\n]\n",
            rules
                .iter()
                .map(|r| format!("  {}", jsjson::to_string(r)))
                .collect::<Vec<_>>()
                .join(",\n")
        )
    }
}
fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
fn valid_key(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let text = trim(text).to_lowercase();
    if text.is_empty() || jsjson::utf16_len(&text) > 64 {
        return false;
    }
    let mut parts: Vec<&str> = if let Some(prefix) = text.strip_suffix("++") {
        let mut v: Vec<_> = prefix.split('+').collect();
        v.push("+");
        v
    } else {
        text.split('+').collect()
    };
    let Some(last) = parts.pop() else {
        return false;
    };
    for part in parts {
        if !matches!(
            trim(part),
            "mod"
                | "cmd"
                | "command"
                | "meta"
                | "super"
                | "ctrl"
                | "control"
                | "alt"
                | "option"
                | "opt"
                | "shift"
        ) {
            return false;
        }
    }
    let key = trim(last);
    if key.is_empty() {
        return false;
    }
    jsjson::utf16_len(key) == 1
        || matches!(
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
                | "left"
                | "right"
                | "up"
                | "down"
                | "esc"
                | "return"
                | "del"
                | "plus"
                | "comma"
                | "period"
        )
        || (1..=19).any(|n| key == format!("f{n}"))
}
// Only syntax is validated here. Unknown context names are legal and evaluate false in the clients.
fn valid_when(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let text = trim(text);
    if text.is_empty() || jsjson::utf16_len(text) > 256 {
        return false;
    }
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let c = bytes[index];
        let character = text[index..].chars().next().unwrap();
        if js_space(character) {
            index += character.len_utf8();
            continue;
        }
        let start = index;
        if c.is_ascii_alphabetic() || c == b'_' {
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'.'))
            {
                index += 1;
            }
        } else if matches!(c, b'&' | b'|') && bytes.get(index + 1) == Some(&c) {
            index += 2;
        } else {
            index += 1;
        }
        let Some(token) = text.get(start..index) else {
            return false;
        };
        tokens.push(token);
    }
    fn unary(tokens: &[&str], at: &mut usize, depth: usize) -> bool {
        match tokens.get(*at).copied() {
            Some("!") => {
                *at += 1;
                unary(tokens, at, depth)
            }
            Some("(") => {
                if depth >= 32 {
                    return false;
                }
                *at += 1;
                if !or(tokens, at, depth + 1) || tokens.get(*at) != Some(&")") {
                    return false;
                }
                *at += 1;
                true
            }
            Some(t)
                if t.as_bytes()
                    .first()
                    .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') =>
            {
                *at += 1;
                true
            }
            _ => false,
        }
    }
    fn and(tokens: &[&str], at: &mut usize, depth: usize) -> bool {
        if !unary(tokens, at, depth) {
            return false;
        }
        while tokens.get(*at) == Some(&"&&") {
            *at += 1;
            if !unary(tokens, at, depth) {
                return false;
            }
        }
        true
    }
    fn or(tokens: &[&str], at: &mut usize, depth: usize) -> bool {
        if !and(tokens, at, depth) {
            return false;
        }
        while tokens.get(*at) == Some(&"||") {
            *at += 1;
            if !and(tokens, at, depth) {
                return false;
            }
        }
        true
    }
    let mut at = 0;
    or(&tokens, &mut at, 0) && at == tokens.len()
}
fn read_rule(entry: &Value) -> Result<Value, String> {
    let Some(object) = entry.as_object() else {
        return Err("is not an object".into());
    };
    let command = object.get("command");
    if !command
        .and_then(Value::as_str)
        .is_some_and(|c| COMMANDS.iter().any(|(id, _)| *id == c))
    {
        return Err(format!("has an unknown command {}", stringify(command)));
    }
    let key = object.get("key");
    if !key.is_some_and(valid_key) {
        return Err(format!("has a key Milagre can't read: {}", stringify(key)));
    }
    if let Some(when) = object.get("when") {
        if !valid_when(when) {
            return Err(format!(
                "has a when it can't read: {}",
                stringify(Some(when))
            ));
        }
    }
    let mut rule = json!({"key":trim(key.unwrap().as_str().unwrap()),"command":command.unwrap()});
    if let Some(when) = object.get("when") {
        rule["when"] = json!(trim(when.as_str().unwrap()));
    }
    Ok(rule)
}
fn lenient_json(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '"' => {
                out.push('"');
                index += 1;
                while index < chars.len() {
                    let c = chars[index];
                    out.push(c);
                    index += 1;
                    if c == '\\' {
                        if index < chars.len() {
                            out.push(chars[index]);
                            index += 1;
                        }
                    } else if c == '"' {
                        break;
                    }
                }
            }
            '/' if chars.get(index + 1) == Some(&'/') => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '/' if chars.get(index + 1) == Some(&'*') => {
                index += 2;
                while index < chars.len()
                    && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/'))
                {
                    index += 1;
                }
                index = (index + 2).min(chars.len());
            }
            c => {
                if matches!(c, ']' | '}') {
                    let end = out.trim_end_matches(js_space).len();
                    if out[..end].ends_with(',') {
                        out.remove(end - 1);
                    }
                }
                out.push(c);
                index += 1;
            }
        }
    }
    out
}
// V8's messages for the structural JSON failures the parser reports. The text around an unexpected token
// is diagnostic only; it is not executed or passed to Node.
fn json_error(text: &str, error: &str) -> String {
    let (reason, position) = error.rsplit_once(" at position ").unwrap_or((error, "0"));
    let mut position = position.parse::<usize>().unwrap_or(0).min(text.len());
    // jsjson detects a bad literal at its start; V8 points at its first mismatching character.
    if reason == "Unexpected token" {
        let tail = &text[position..];
        let word = match tail.as_bytes().first() {
            Some(b't') => Some("true"),
            Some(b'f') => Some("false"),
            Some(b'n') => Some("null"),
            _ => None,
        };
        if let Some(word) = word {
            position += tail
                .bytes()
                .zip(word.bytes())
                .take_while(|(a, b)| a == b)
                .count();
        }
    }
    let prefix = text.get(..position).unwrap_or("");
    let utf16 = prefix.encode_utf16().count();
    let line = prefix.bytes().filter(|c| *c == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .encode_utf16()
        .count()
        + 1;
    let located = |message: &str| {
        format!("{message} in JSON at position {utf16} (line {line} column {column})")
    };
    match reason {
        "Unexpected end of JSON input" => reason.into(),
        "Expected a property name" => located(if prefix.trim_end().ends_with('{') { "Expected property name or '}'" } else { "Expected double-quoted property name" }),
        "Expected ':'" => located("Expected ':' after property name"),
        "Expected ',' or '}'" => located("Expected ',' or '}' after property value"),
        "Expected ',' or ']'" => located("Expected ',' or ']' after array element"),
        "Unexpected data after JSON" => format!("Unexpected non-whitespace character after JSON at position {utf16} (line {line} column {column})"),
        "Unterminated string in JSON" | "Unterminated string" => located("Unterminated string"),
        "No number after minus sign" | "Unterminated fractional number" | "Exponent part is missing a number" | "Bad Unicode escape" | "Bad escaped character" | "Bad control character in string literal" => located(reason),
        _ => {
            if matches!(text,"undefined"|"NaN"|"Infinity"|"[object Object]") { return format!("\"{text}\" is not valid JSON"); }
            let token=text.get(position..).and_then(|s|s.chars().next()).unwrap_or('\0');
            if token=='\0' { return "Unexpected end of JSON input".into(); }
            let units: Vec<u16> = text.encode_utf16().collect();
            let snippet = if units.len() <= 20 { format!("\"{text}\"") } else {
                let start = utf16.saturating_sub(10);
                let end = (utf16 + 10).min(units.len());
                format!("{}\"{}\"{}", if utf16 >= 10 {"..."} else {""}, String::from_utf16_lossy(&units[start..end]), if utf16 + 10 < units.len() {"..."} else {""})
            };
            format!("Unexpected token '{token}', {snippet} is not valid JSON")
        }
    }
}
struct State {
    rules: Vec<Value>,
    issues: Vec<String>,
    broken: bool,
}
impl State {
    fn public(&self, files: &Files) -> Value {
        json!({"path":files.path(FILE),"rules":self.rules,"issues":self.issues})
    }
}
#[derive(Default)]
pub struct Keybindings {
    last: Option<String>,
}
impl Keybindings {
    fn write_seen(files: &Files, seen: &[Value]) -> Result<(), RpcError> {
        files.write(
            SEEN,
            format!("{}\n", jsjson::to_string(&json!(seen))).as_bytes(),
            false,
        )
    }
    fn load(&self, files: &Files) -> Result<State, RpcError> {
        let bytes = match files.read(FILE) {
            Ok(bytes) => bytes,
            Err(error) if error.code == "ENOENT" => {
                let rules = defaults();
                files.write(FILE, format_rules(&rules).as_bytes(), false)?;
                Self::write_seen(files, &all_commands())?;
                return Ok(State {
                    rules,
                    issues: vec![],
                    broken: false,
                });
            }
            Err(error) => {
                return Ok(State {
                    rules: defaults(),
                    issues: vec![format!(
                    "keybindings.json can't be read: {}. Milagre uses the defaults until it can.",
                    error.message
                )],
                    broken: true,
                })
            }
        };
        let text = lenient_json(&String::from_utf8_lossy(&bytes));
        let parsed=match jsjson::parse(&text) { Ok(value)=>value, Err(error)=>return Ok(State {rules:defaults(),issues:vec![format!("keybindings.json isn't valid JSON: {}. Milagre uses the defaults until it is fixed.",json_error(&text,&error))],broken:true}) };
        let Some(entries) = parsed.as_array() else {
            return Ok(State {
                rules: defaults(),
                issues: vec!["The file is not a JSON array of rules.".into()],
                broken: true,
            });
        };
        let mut rules = Vec::new();
        let mut issues = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            if rules.len() >= 256 {
                issues.push("Only the first 256 rules are read.".into());
                break;
            }
            match read_rule(entry) {
                Ok(rule) => rules.push(rule),
                Err(error) => issues.push(format!("Rule {} {error}.", index + 1)),
            }
        }
        let seen = files.value(SEEN);
        let seen: Vec<Value> = seen
            .as_array()
            .map(|a| a.iter().filter(|v| v.is_string()).cloned().collect())
            .unwrap_or_default();
        let mut next = Vec::new();
        for value in &seen {
            if !next.contains(value) {
                next.push(value.clone());
            }
        }
        let mut added = false;
        for (command, key) in COMMANDS {
            let value = json!(command);
            if next.contains(&value) {
                continue;
            }
            next.push(value);
            if rules.iter().any(|rule| rule["command"] == *command) {
                continue;
            }
            rules.push(json!({"key":key,"command":command}));
            added = true;
        }
        if issues.is_empty() {
            if added {
                files.write(FILE, format_rules(&rules).as_bytes(), false)?;
            }
            if added || next.len() != seen.len() {
                Self::write_seen(files, &next)?;
            }
        }
        Ok(State {
            rules,
            issues,
            broken: false,
        })
    }
    fn write(
        &mut self,
        files: &Files,
        rules: Vec<Value>,
        overwrite: bool,
    ) -> Result<(Value, Option<&'static str>), RpcError> {
        if self.load(files)?.broken && !overwrite {
            return Err(failed("keybindings.json has errors; fix or reset it first"));
        }
        files.write(FILE, format_rules(&rules).as_bytes(), false)?;
        Self::write_seen(files, &all_commands())?;
        let view = State {
            rules,
            issues: vec![],
            broken: false,
        }
        .public(files);
        self.last = Some(jsjson::to_string(&view));
        Ok((view, Some(CHANGED)))
    }
    pub fn call(
        &mut self,
        files: &Files,
        method: &str,
        args: &[Value],
    ) -> Result<(Value, Option<&'static str>), RpcError> {
        if method == "keybindings:read" {
            let view = self.load(files)?.public(files);
            self.last = Some(jsjson::to_string(&view));
            return Ok((view, None));
        }
        if method == "keybindings:reset" {
            return self.write(files, defaults(), true);
        }
        let command = args.first();
        let Some(command) = command
            .and_then(Value::as_str)
            .filter(|command| COMMANDS.iter().any(|(id, _)| id == command))
        else {
            return Err(failed(format!(
                "Unknown keybinding command {}.",
                stringify(command)
            )));
        };
        let reset;
        let entries = if method == "keybindings:reset-command" {
            reset = vec![json!({"key":COMMANDS.iter().find(|(id,_)|*id==command).unwrap().1})];
            &reset
        } else {
            args.get(1)
                .and_then(Value::as_array)
                .ok_or_else(|| failed("Keybinding rules must be a list."))?
        };
        let mut checked = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let mut candidate = entry.as_object().cloned().unwrap_or_default();
            candidate.insert("command".into(), json!(command));
            let rule = read_rule(&Value::Object(candidate))
                .map_err(|error| failed(format!("Keybinding {} {error}.", index + 1)))?;
            // JS creates {key, when?, command} in this order for a replacement, unlike a loaded rule.
            let mut replacement = json!({"key":rule["key"]});
            if let Some(when) = rule.get("when") {
                replacement["when"] = when.clone();
            }
            replacement["command"] = json!(command);
            checked.push(replacement);
        }
        let state = self.load(files)?;
        if state.broken {
            return Err(failed("keybindings.json has errors; fix or reset it first"));
        }
        let mut rules: Vec<_> = state
            .rules
            .into_iter()
            .filter(|r| r["command"] != command)
            .collect();
        rules.extend(checked);
        self.write(files, rules, false)
    }
    /// Called after the host debounce. Compare serialized views just as Node does; a save with
    /// `when` can emit again when load restores the rule property order (key, command, when).
    pub fn poll(&mut self, files: &Files) -> Result<Option<Value>, RpcError> {
        let view = self.load(files)?.public(files);
        let encoded = jsjson::to_string(&view);
        if self.last.as_ref() == Some(&encoded) {
            Ok(None)
        } else {
            self.last = Some(encoded);
            Ok(Some(view))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_diagnostics_follow_v8_structural_errors() {
        for (text, expected) in [
            (
                "{broken",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            ("tru", "Unexpected end of JSON input"),
            ("trux", "Unexpected token 'x', \"trux\" is not valid JSON"),
            (
                "[1 2]",
                "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
            ),
            (
                "1e",
                "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"foo",
                "Unterminated string in JSON at position 4 (line 1 column 5)",
            ),
        ] {
            assert_eq!(
                json_error(text, &jsjson::parse(text).unwrap_err()),
                expected
            );
        }
    }
    #[test]
    fn jsonc_and_validation() {
        assert_eq!(
            lenient_json("[ // note\n {\"key\":\"mod++\",/*hi*/},]\n"),
            "[ \n {\"key\":\"mod++\"}]\n"
        );
        for key in ["mod++", " Command+K ", "f19", "mod+left", "é"] {
            assert!(valid_key(&json!(key)), "{key}");
        }
        for key in ["mod", "mod+", "f20", "mod+a+b", "😀"] {
            assert!(!valid_key(&json!(key)), "{key}");
        }
        for when in [
            "chatView && !terminalFocus",
            "(a || b) && !!c",
            "unknown.name",
            "a\u{a0}&&\u{feff}b",
            "\u{feff}chatView\u{feff}",
        ] {
            assert!(valid_when(&json!(when)), "{when}");
        }
        for when in ["", "a & b", "a ||", "(a", "a b", "a\u{85}&&b"] {
            assert!(!valid_when(&json!(when)), "{when}");
        }
    }
}
