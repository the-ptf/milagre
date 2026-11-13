//! A Routine's prompt placeholders: `packages/shared/src/routine-prompt.mjs` (the list each trigger fills, and the text
//! helpers behind the `{{` autocomplete). Rendering a prompt with its fenced untrusted text is the daemon's.

use super::form::TriggerKind;
use super::model::LinearEvent;

/// One placeholder the autocomplete lists, with an example of what it expands to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placeholder {
    pub name: &'static str,
    pub example: &'static str,
}

const fn p(name: &'static str, example: &'static str) -> Placeholder {
    Placeholder { name, example }
}

const SCHEDULE: [Placeholder; 2] = [p("date", "2026-10-16"), p("time", "08:30")];
const ISSUE: [Placeholder; 8] = [
    p("issue.key", "MIL-142"),
    p("issue.title", "Paste images in chat"),
    p("issue.description", "Pasting a screenshot into the composer does nothing."),
    p("issue.url", "https://linear.app/milagre/issue/MIL-142/paste-images-in-chat"),
    p("issue.labels", "agent, bug"),
    p("issue.state", "Todo"),
    p("issue.team", "MIL"),
    p("issue.assignee", "Victor"),
];
const COMMENT: [Placeholder; 2] = [p("comment.body", "Can you also cover Android?"), p("comment.author", "Ana")];
const WEBHOOK: [Placeholder; 5] = [
    p("body", "{\u{2026}}"),
    p("request", "POST {\u{2026}}"),
    p("body.<path>", "value"),
    p("headers.<name>", "value"),
    p("query.<name>", "value"),
];

/// The placeholders a trigger fills, in the order the autocomplete lists them (`placeholdersFor`).
pub fn placeholders_for(trigger: TriggerKind, event: LinearEvent) -> Vec<Placeholder> {
    match trigger {
        TriggerKind::Schedule => SCHEDULE.to_vec(),
        TriggerKind::Linear if event == LinearEvent::Comment => ISSUE.iter().chain(COMMENT.iter()).copied().collect(),
        TriggerKind::Linear => ISSUE.to_vec(),
        TriggerKind::Webhook => WEBHOOK.to_vec(),
    }
}

/// "body." for a dynamic name like "body.<path>": inserting it leaves the caret where the path goes.
pub fn dynamic_prefix(name: &str) -> Option<&str> {
    name.find('<').map(|at| &name[..at])
}

/// The placeholder being typed at `caret` (a byte offset on a char boundary).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceholderQuery {
    /// Where the `{{` is (the first brace of a longer run).
    pub start: usize,
    pub query: String,
    pub matches: Vec<&'static str>,
}

/// The placeholder being typed at `caret` (`placeholderQuery`): the last `{{` before it, then optional spaces and a name
/// with no whitespace or braces. `None` when the caret isn't in one.
pub fn placeholder_query(text: &str, caret: usize, names: &[&'static str]) -> Option<PlaceholderQuery> {
    let caret = caret.min(text.len());
    let before = text.get(..caret)?;
    let last = before.rfind("{{")?;
    let after = &before[last + 2..];
    let name = after.trim_start_matches([' ', '\t']);
    if name.chars().any(|c| c.is_whitespace() || c == '{' || c == '}') {
        return None;
    }
    let mut start = last;
    while start > 0 && before.as_bytes()[start - 1] == b'{' {
        start -= 1;
    }
    let prefix = name.to_lowercase();
    Some(PlaceholderQuery {
        start,
        query: name.to_string(),
        matches: names.iter().copied().filter(|n| n.to_lowercase().starts_with(&prefix)).collect(),
    })
}

/// Replaces what was typed from `start` (the `{{`) to `caret` with the placeholder and puts the caret after its `}}`.
/// Text right after the caret goes too when it is the rest of this placeholder (`insertPlaceholder`).
pub fn insert_placeholder(text: &str, start: usize, caret: usize, name: &str) -> (String, usize) {
    let placeholder = format!("{{{{{name}}}}}");
    let tail = &text[caret..];
    let rest_len = tail.bytes().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')).count();
    let braces = tail[rest_len..].bytes().take_while(|b| *b == b'}').count().min(2);
    let rest = &tail[..rest_len];
    let typed = text[start..caret].trim_start_matches('{').trim_start_matches([' ', '\t']);
    let taken = if braces > 0 {
        rest_len + braces
    } else if !rest.is_empty() && name.to_lowercase().starts_with(&format!("{typed}{rest}").to_lowercase()) {
        rest_len
    } else {
        0
    };
    (format!("{}{}{}", &text[..start], placeholder, &tail[taken..]), start + placeholder.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 3] = ["issue.key", "issue.title", "date"];

    #[test]
    fn each_trigger_lists_its_own_fields() {
        let names = |trigger, event| placeholders_for(trigger, event).iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names(TriggerKind::Schedule, LinearEvent::Assigned), ["date", "time"]);
        assert_eq!(names(TriggerKind::Linear, LinearEvent::Assigned).len(), 8);
        assert_eq!(names(TriggerKind::Linear, LinearEvent::Comment).len(), 10);
        assert_eq!(names(TriggerKind::Webhook, LinearEvent::Assigned)[2], "body.<path>");
    }

    #[test]
    fn typing_braces_lists_the_names_that_begin_with_what_follows() {
        let query = placeholder_query("Fix {{iss", 9, &NAMES).unwrap();
        assert_eq!((query.start, query.query.as_str(), query.matches.as_slice()), (4, "iss", ["issue.key", "issue.title"].as_slice()));
        assert_eq!(placeholder_query("Fix {{", 6, &NAMES).unwrap().matches.len(), 3);
        // Spaces may follow the braces; a longer run starts at its first brace.
        assert_eq!(placeholder_query("{{ issue.k", 10, &NAMES).unwrap().matches, ["issue.key"]);
        assert_eq!(placeholder_query("a {{{da", 7, &NAMES).unwrap().start, 2);
        // Closed, spaced out or absent: not in a placeholder.
        assert_eq!(placeholder_query("{{date}} then", 13, &NAMES), None);
        assert_eq!(placeholder_query("{{date now", 10, &NAMES), None);
        assert_eq!(placeholder_query("plain", 5, &NAMES), None);
        assert_eq!(placeholder_query("{{ISS", 5, &NAMES).unwrap().matches, ["issue.key", "issue.title"]);
    }

    #[test]
    fn inserting_replaces_what_was_typed_and_the_rest_of_the_name() {
        assert_eq!(insert_placeholder("Fix {{iss", 4, 9, "issue.key"), ("Fix {{issue.key}}".into(), 17));
        assert_eq!(insert_placeholder("{{iss|ue.key}} x".replace('|', "").as_str(), 0, 5, "issue.key"), ("{{issue.key}} x".into(), 13));
        assert_eq!(insert_placeholder("{{iss}", 0, 5, "issue.key").0, "{{issue.key}}");
        assert_eq!(insert_placeholder("{{issue", 0, 5, "issue.key").0, "{{issue.key}}");
        // Anything else after the caret stays.
        assert_eq!(insert_placeholder("Fix ({{) now", 5, 7, "date").0, "Fix ({{date}}) now");
        assert_eq!(dynamic_prefix("body.<path>"), Some("body."));
        assert_eq!(dynamic_prefix("date"), None);
    }
}
