//! Parsers for the process and listener listings, ported from `parsePs`, `parseLsof` and `parseTaskOutputs` in
//! packages/core/src/agents/ports.cjs. They read the same text on every platform: `ps` on macOS and Linux, and the
//! PowerShell scripts in [`crate::exec`] that print the same shapes on Windows.

use std::collections::HashMap;

use serde::Serialize;

/// One `ps -axo pid=,ppid=,pgid=,comm=` row. On Windows the script prints `pid ppid pid @<start ticks> <name>`:
/// the group is the pid and `started_at` identifies the process across pid reuse.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessRow {
    pub pid: i64,
    pub ppid: i64,
    pub pgid: i64,
    pub command: String,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// One TCP listener from `lsof -F pcn`, one per pid and port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Listener {
    pub pid: i64,
    pub command: String,
    pub port: i64,
    pub address: String,
}

fn lines(output: &str) -> impl Iterator<Item = &str> {
    output.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// JavaScript `Number(text)` for the digit strings these listings hold; anything else is 0 (falsy, like NaN).
fn number(text: &str) -> i64 {
    let text = text.trim();
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse().unwrap_or(0)
    } else {
        0
    }
}

/// Splits `^\s*(\d+)\s+(rest)` once: the leading number and what follows its whitespace.
fn leading_number(text: &str) -> Option<(i64, &str)> {
    let text = text.trim_start();
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &text[digits..];
    let spaced = rest.len() - rest.trim_start().len();
    if spaced == 0 {
        return None;
    }
    Some((text[..digits].parse().ok()?, rest.trim_start()))
}

pub fn parse_ps(output: &str) -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    for line in lines(output) {
        // `^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$`: the last `\s+` needs at least one whitespace after the group.
        let Some((pid, rest)) = leading_number(line) else { continue };
        let Some((ppid, rest)) = leading_number(rest) else { continue };
        let trimmed = rest.trim_start();
        let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || trimmed.len() == digits || !trimmed[digits..].starts_with(char::is_whitespace) {
            continue;
        }
        let Ok(pgid) = trimmed[..digits].parse() else { continue };
        let command = trimmed[digits..].trim();
        let windows = command.strip_prefix('@').and_then(|tail| {
            let ticks = tail.bytes().take_while(u8::is_ascii_digit).count();
            (ticks > 0 && tail[ticks..].starts_with(' ')).then(|| (tail[..ticks].to_owned(), tail[ticks + 1..].to_owned()))
        });
        let (command, started_at) = match windows {
            Some((ticks, name)) => (name, Some(ticks)),
            None => (command.to_owned(), None),
        };
        rows.push(ProcessRow { pid, ppid, pgid, command, started_at });
    }
    rows
}

pub fn parse_lsof(output: &str) -> Vec<Listener> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let (mut pid, mut command) = (0i64, String::new());
    for line in lines(output) {
        let Some(tag) = line.chars().next() else { continue };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => pid = number(value),
            'c' => command = value.to_owned(),
            'n' => {
                // `^(.*):(\d+)$`: the port is the digits after the last colon.
                let Some(colon) = value.rfind(':') else { continue };
                let digits = &value[colon + 1..];
                if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || pid == 0 {
                    continue;
                }
                let port: i64 = digits.parse().unwrap_or(i64::MAX);
                if !seen.insert((pid, port)) {
                    continue;
                }
                let address = &value[..colon];
                let address = address.strip_prefix('[').unwrap_or(address);
                let address = address.strip_suffix(']').unwrap_or(address);
                rows.push(Listener { pid, command: command.clone(), port, address: address.to_owned() });
            }
            _ => {}
        }
    }
    rows
}

/// Claude Code points a background command's stdout at its task's output file, `<session>/tasks/<task id>.output`.
pub fn task_id(path: &str) -> Option<&str> {
    let name = path.strip_suffix(".output")?;
    let separator = name.rfind(['/', '\\'])?;
    let id = &name[separator + 1..];
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    let folder = name[..separator].strip_suffix("tasks")?;
    folder.ends_with(['/', '\\']).then_some(id)
}

/// `lsof -d 1 -F pn`: each pid whose stdout writes to a background task's output, and that task.
pub fn parse_task_outputs(output: &str) -> HashMap<i64, String> {
    let mut tasks = HashMap::new();
    let mut pid = 0;
    for line in lines(output) {
        if let Some(value) = line.strip_prefix('p') {
            pid = number(value);
        } else if let Some(value) = line.strip_prefix('n') {
            if pid != 0 {
                if let Some(id) = task_id(value) {
                    tasks.insert(pid, id.to_owned());
                }
            }
        }
    }
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_follow_the_node_pattern() {
        assert_eq!(task_id("/private/tmp/claude-501/-repo/abc/tasks/bk1x2y3z4.output"), Some("bk1x2y3z4"));
        assert_eq!(task_id("C:\\Temp\\tasks\\b9.output"), Some("b9"));
        assert_eq!(task_id("/x/mytasks/b9.output"), None);
        assert_eq!(task_id("/x/tasks/.output"), None);
        assert_eq!(task_id("/x/tasks/a.b.output"), None);
        assert_eq!(task_id(&format!("/x/tasks/{}.output", "a".repeat(101))), None);
    }
}
