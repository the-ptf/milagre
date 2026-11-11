//! What a finished tool step says about itself: `summarizeStep` (shared/tool-activity.mjs) with `stepSections` and
//! `plainTaskOutput` (shared/chat-activity.mjs), and `capOutput` (shared/agent-runs.mjs).
//!
//! Strings are the encoded JavaScript strings of [`crate::jsjson`]; lengths and slices count UTF-16 code units. The
//! multiline patterns (`^…$` with the `m` flag) are matched by hand: JavaScript ends a line at `\n`, `\r`, U+2028 and
//! U+2029, which no flag of the `regex` crate reproduces, and its `\s` is its own set (U+FEFF in, U+0085 out).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::jsjson;

pub const MAX_OUTPUT: usize = 20_000;

/// JavaScript `\s` (WhiteSpace and LineTerminator).
pub fn is_js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.slice(start, end)` in UTF-16 code units (`end` None: to the end); a cut surrogate pair stays a lone half.
pub fn slice16(text: &str, start: usize, end: Option<usize>) -> String {
    let units = jsjson::to_utf16(text);
    let end = end.unwrap_or(units.len()).min(units.len());
    jsjson::from_utf16(&units[start.min(end)..end])
}

/// capOutput: command output keeps its end, where results and errors are.
pub fn cap_output(text: &str) -> String {
    let units = jsjson::to_utf16(text);
    if units.len() <= MAX_OUTPUT {
        return text.to_string();
    }
    format!(
        "… truncated\n{}",
        jsjson::from_utf16(&units[units.len() - MAX_OUTPUT..])
    )
}

fn escapes() -> &'static Regex {
    static ESCAPES: OnceLock<Regex> = OnceLock::new();
    ESCAPES.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[@-~]")
            .unwrap()
    })
}

/// plainTaskOutput: terminal escapes removed, and each line as a terminal shows it after carriage returns.
pub fn plain_task_output(text: &str) -> String {
    escapes()
        .replace_all(text, "")
        .split('\n')
        .map(|line| {
            line.trim_end_matches('\r')
                .rsplit('\r')
                .next()
                .unwrap_or("")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn kind(step: &Map<String, Value>) -> Option<&str> {
    step.get("kind").and_then(Value::as_str)
}

/// The output section of stepSections (the input isn't needed here).
fn step_output(step: &Map<String, Value>) -> String {
    let text = match jsjson::nullish(step.get("detail"), None) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => jsjson::property_key(Some(other)),
        None => String::new(),
    };
    if matches!(kind(step), Some("shell" | "setup")) && text.starts_with("$ ") {
        if jsjson::truthy(step.get("input")) {
            let input = jsjson::property_key(step.get("input"));
            let prefix = format!("$ {input}\n");
            if text.starts_with(&prefix) {
                return text[prefix.len()..].to_string();
            }
        }
        return match text.find('\n') {
            Some(newline) => text[newline + 1..].to_string(),
            None => String::new(),
        };
    }
    text
}

fn line_starts(chars: &[char]) -> impl Iterator<Item = usize> + '_ {
    (0..chars.len()).filter(|&at| at == 0 || is_line_end(chars[at - 1]))
}

fn starts_with(chars: &[char], at: usize, word: &str) -> bool {
    let word: Vec<char> = word.chars().collect();
    chars.len() >= at + word.len() && chars[at..at + word.len()] == word[..]
}

fn space_run(chars: &[char], from: usize) -> usize {
    let mut at = from;
    while at < chars.len() && is_js_space(chars[at]) {
        at += 1;
    }
    at
}

/// `/^(?:#|ℹ)\s+<word> (\d+)\s*$/m.exec(output)?.[1]`.
fn tap_count(chars: &[char], word: &str) -> Option<String> {
    for start in line_starts(chars) {
        if !matches!(chars[start], '#' | 'ℹ') {
            continue;
        }
        let spaced = space_run(chars, start + 1);
        if spaced == start + 1 || !starts_with(chars, spaced, &format!("{word} ")) {
            continue;
        }
        let digits = spaced + word.chars().count() + 1;
        let mut end = digits;
        while end < chars.len() && chars[end].is_ascii_digit() {
            end += 1;
        }
        if end == digits {
            continue;
        }
        // `\s*$`: the spaces after the digits reach the end, or hold a line end.
        let mut at = end;
        let ends = loop {
            if at == chars.len() {
                break true;
            }
            if !is_js_space(chars[at]) {
                break false;
            }
            if is_line_end(chars[at]) {
                break true;
            }
            at += 1;
        };
        if ends {
            return Some(chars[digits..end].iter().collect());
        }
    }
    None
}

/// `/^\s*Tests\s+([^\n]+)$/m.exec(output)?.[1]`.
fn totals_line(chars: &[char]) -> Option<String> {
    for start in line_starts(chars) {
        let at = space_run(chars, start);
        if !starts_with(chars, at, "Tests") {
            continue;
        }
        let after = at + 5;
        let spaced = space_run(chars, after);
        if spaced == after {
            continue;
        }
        // `\s+` gives back spaces until `[^\n]+` can start.
        let Some(from) = (after + 1..=spaced)
            .rev()
            .find(|&from| from < chars.len() && chars[from] != '\n')
        else {
            continue;
        };
        let end = (from..chars.len())
            .find(|&at| chars[at] == '\n')
            .unwrap_or(chars.len());
        return Some(chars[from..end].iter().collect());
    }
    None
}

/// `/\d+\s+(?:passed|failed|skipped)/.test(text)`.
fn counts_results(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len()).any(|at| {
        if !chars[at].is_ascii_digit() {
            return false;
        }
        let spaced = space_run(&chars, at + 1);
        spaced > at + 1
            && ["passed", "failed", "skipped"]
                .iter()
                .any(|word| starts_with(&chars, spaced, word))
    })
}

/// The failure-reason pattern of summarizeStep (`/…/i` without `u`: ASCII-only case folding and word characters).
fn failure_line() -> &'static Regex {
    static FAILURE: OnceLock<Regex> = OnceLock::new();
    FAILURE.get_or_init(|| {
        let space = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
        Regex::new(&format!(
            r"(?-u:\b)(?i-u:[0-9A-Za-z_]*error|failed|failure|denied|not found|permission|exception)(?-u:\b)|^(?:(?i-u:not ok)(?-u:\b)|[✖×]|(?i-u:FAIL)(?::|{space}+[^0-9]))"
        ))
        .unwrap()
    })
}

/// summarizeStep: the facts a completed step keeps (`summary`, `error`), from its output.
pub fn summarize_step(step: &Map<String, Value>) -> Map<String, Value> {
    let mut facts = Map::new();
    if kind(step) == Some("thinking") {
        return facts;
    }
    let plain = plain_task_output(&step_output(step));
    let output = js_trim(&plain);
    let chars: Vec<char> = output.chars().collect();
    let mut tests: Option<String> = None;
    if kind(step) == Some("shell") {
        if let (Some(pass), Some(fail)) = (tap_count(&chars, "pass"), tap_count(&chars, "fail")) {
            let failed = fail.bytes().any(|digit| digit != b'0');
            tests = Some(if failed {
                format!("{fail} failed · {pass} passed")
            } else {
                format!("{pass} passed")
            });
        }
        if tests.is_none() {
            if let Some(totals) = totals_line(&chars).filter(|totals| counts_results(totals)) {
                tests = Some(slice16(js_trim(&totals), 0, Some(80)));
            }
        }
    }
    if step.get("status").and_then(Value::as_str) == Some("failed") {
        let lines: Vec<&str> = output
            .split('\n')
            .map(js_trim)
            .filter(|line| !line.is_empty())
            .collect();
        let reason = lines
            .iter()
            .find(|line| failure_line().is_match(line))
            .or(lines.first());
        facts.insert(
            "summary".into(),
            json!(tests.unwrap_or_else(|| "Failed".into())),
        );
        if let Some(reason) = reason {
            facts.insert("error".into(), json!(slice16(reason, 0, Some(200))));
        }
        return facts;
    }
    if kind(step) == Some("edit") && !output.is_empty() {
        let lines: Vec<&str> = output.split('\n').collect();
        let added = lines
            .iter()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count();
        let removed = lines
            .iter()
            .filter(|line| line.starts_with('-') && !line.starts_with("---"))
            .count();
        if added > 0 || removed > 0 {
            facts.insert("summary".into(), json!(format!("+{added} -{removed}")));
            return facts;
        }
    }
    if let Some(tests) = tests {
        facts.insert("summary".into(), json!(tests));
        return facts;
    }
    if jsjson::truthy(step.get("source")) && (output.starts_with('[') || output.starts_with('{')) {
        if let Ok(items) = jsjson::parse(output) {
            let rows = match &items {
                Value::Array(_) => Some(&items),
                Value::Object(map) => jsjson::nullish(
                    map.get("issues"),
                    jsjson::nullish(map.get("results"), map.get("rows")),
                ),
                _ => None,
            };
            if let Some(Value::Array(rows)) = rows {
                let count = rows.len();
                facts.insert(
                    "summary".into(),
                    json!(format!(
                        "{count} result{}",
                        if count == 1 { "" } else { "s" }
                    )),
                );
            }
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(step: Value) -> Value {
        Value::Object(summarize_step(step.as_object().unwrap()))
    }

    #[test]
    fn patterns_compile_and_read_tap_and_totals() {
        let tap = json!({ "kind": "shell", "status": "done", "detail": "$ npm test\n# pass 12\n# fail 0\n" });
        assert_eq!(summary(tap), json!({ "summary": "12 passed" }));
        let vitest = json!({ "kind": "shell", "status": "done", "detail": "$ x\n Tests  3 failed | 9 passed (12)\n" });
        assert_eq!(
            summary(vitest),
            json!({ "summary": "3 failed | 9 passed (12)" })
        );
        let failed =
            json!({ "kind": "shell", "status": "failed", "detail": "$ x\nfoo\nError: nope\n" });
        assert_eq!(
            summary(failed),
            json!({ "summary": "Failed", "error": "Error: nope" })
        );
        let sep =
            json!({ "kind": "shell", "status": "done", "detail": "# pass 2\u{2028}# fail 1" });
        assert_eq!(summary(sep), json!({ "summary": "1 failed · 2 passed" }));
        assert_eq!(plain_task_output("a\x1b[31mred\x1b[0m\r\nb\rc"), "ared\nc");
        assert!(!failure_line().is_match(
            "ſtatus failed"
                .replace("failed", "faiLeD")
                .replace('L', "\u{212a}")
                .as_str()
        ));
        assert!(failure_line().is_match("FAILED tests"));
        assert!(failure_line().is_match("✖ boom"));
    }
}
