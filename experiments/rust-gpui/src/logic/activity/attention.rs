//! After `packages/shared/src/attention.mjs`: the notification text for Chats that wait on the user, and the
//! attention chip's words and counts.
//!
//! Not ported here, because they read the full coordinator state through other modules (`chats.mjs`,
//! `chat-activity.mjs`, `subchat-escalation.mjs`) that belong to another work package: `attentionContext`,
//! `inboxSnapshot`, `visibleInbox` and the re-exported `notificationPreview`.
//! [`chats_needing_attention`] needs only the key helpers, which are repeated here in minimal form (they match
//! `chat-scopes.mjs` and `agent-runs.mjs`).

use std::collections::HashSet;

use crate::data::Provider;
use crate::logic::copy::js;
use crate::logic::prompts::text::{group_one_options, next_boundary};

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\s*` from `at`: the length of the whitespace run.
fn whitespace_len(text: &str, at: usize) -> usize {
    text[at..].chars().take_while(|c| js::is_space(*c)).map(char::len_utf8).sum()
}

/// ```` ```[^\n]*\n[\s\S]*?(?:```|$) ```` becomes one space: a fenced block with an info line.
fn replace_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if text[at..].starts_with("```")
            && let Some(newline) = text[at + 3..].find('\n')
        {
            let body = at + 3 + newline + 1;
            let end = text[body..].find("```").map_or(text.len(), |found| body + found + 3);
            out.push(' ');
            at = end;
            continue;
        }
        let c = text[at..].chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `[text](target)` becomes `text` (`min` is the least length of the text), with `lead` (`"!["` for images) in
/// front of the bracket.
fn replace_links(text: &str, lead: &str, min: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let bracket = rest.strip_prefix(lead).and_then(|after| after.strip_prefix('['));
        if let Some(inner) = bracket
            && let Some(close) = inner.find(']')
            && close >= min
            && let Some(target) = inner[close + 1..].strip_prefix('(')
            && let Some(end) = target.find(')')
        {
            out.push_str(&inner[..close]);
            at += rest.len() - target[end + 1..].len();
            continue;
        }
        let c = rest.chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm` replaced by nothing: list, heading and quote markers at the
/// start of a line. `\s*` and `\s+` may run across newlines, as in JavaScript.
fn strip_block_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut previous: Option<char> = None;
    while at < text.len() {
        if previous.is_none_or(is_line_terminator) {
            let p = at + whitespace_len(text, at);
            let rest = &text[p..];
            let hashes = rest.bytes().take_while(|b| *b == b'#').count();
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let end = if (1..=6).contains(&hashes) && whitespace_len(rest, hashes) > 0 {
                Some(p + hashes + whitespace_len(rest, hashes))
            } else if rest.starts_with('>') || (rest.starts_with(['-', '*', '+']) && whitespace_len(rest, 1) > 0) {
                Some(p + 1 + whitespace_len(rest, 1))
            } else if digits > 0 && rest[digits..].starts_with(['.', ')']) && whitespace_len(rest, digits + 1) > 0 {
                Some(p + digits + 1 + whitespace_len(rest, digits + 1))
            } else {
                None
            };
            if let Some(end) = end {
                previous = text[..end].chars().next_back();
                at = end;
                continue;
            }
        }
        let c = text[at..].chars().next().expect("at < len");
        out.push(c);
        previous = Some(c);
        at += c.len_utf8();
    }
    out
}

/// `/(?<![\w/])(\*\*|__|~~)(\w.*?)\1/g` replaced by the middle: bold, underline and strike marks.
fn strip_double_marks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let before_ok = text[..at].chars().next_back().is_none_or(|c| !js::is_word(c) && c != '/');
        if before_ok
            && let Some(marker) = ["**", "__", "~~"].into_iter().find(|marker| rest.starts_with(marker))
            && rest[2..].chars().next().is_some_and(js::is_word)
        {
            let mut pos = 3;
            let found = loop {
                if rest[pos..].starts_with(marker) {
                    break Some(pos);
                }
                match rest[pos..].chars().next() {
                    Some(c) if !is_line_terminator(c) => pos += c.len_utf8(),
                    _ => break None,
                }
            };
            if let Some(pos) = found {
                out.push_str(&rest[2..pos]);
                at += pos + 2;
                continue;
            }
        }
        let c = rest.chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// The group-three text and end of `(\w[^*_\n]*?\w|\w)` followed by the marker `c` and then the end or one of
/// whitespace, `.,!?;:`, starting at `start`.
fn single_mark_body(text: &str, start: usize, marker: char) -> Option<usize> {
    let closes = |end: usize| -> Option<usize> {
        let rest = &text[end..];
        let after = rest.strip_prefix(marker)?;
        let ok = after.chars().next().is_none_or(|c| js::is_space(c) || matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
        ok.then_some(end + marker.len_utf8())
    };
    let first = text[start..].chars().next().filter(|c| js::is_word(*c))?;
    // First alternative: a word char, lazily more, then a word char.
    let mut at = start + first.len_utf8();
    for x in text[at..].chars() {
        if js::is_word(x)
            && let Some(end) = closes(at + x.len_utf8())
        {
            return Some(end);
        }
        if matches!(x, '*' | '_' | '\n') {
            break;
        }
        at += x.len_utf8();
    }
    // Second alternative: one word char.
    closes(start + first.len_utf8())
}

/// `/(^|\s)([*_])(\w[^*_\n]*?\w|\w)\2(?=$|[\s.,!?;:])/g` replaced by `$1$3`: single-mark emphasis around a word.
fn strip_single_marks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let mut matched = false;
        for group in group_one_options(text, at) {
            let p = at + group;
            let Some(marker) = text[p..].chars().next().filter(|c| matches!(c, '*' | '_')) else { continue };
            if let Some(end) = single_mark_body(text, p + 1, marker) {
                out.push_str(&text[at..p]);
                out.push_str(&text[p + 1..end - 1]);
                at = end;
                matched = true;
                break;
            }
        }
        if !matched {
            let next = next_boundary(text, at).min(text.len());
            out.push_str(&text[at..next]);
            at = next;
        }
    }
    out
}

/// `/`+([^`]+)`+/g` replaced by the middle: inline code.
fn strip_inline_code(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if bytes[at] == b'`' {
            let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
            let content = at + run;
            let content_len = bytes[content..].iter().take_while(|b| **b != b'`').count();
            let closer = content + content_len;
            if content_len > 0 && closer < bytes.len() {
                out.push_str(&text[content..closer]);
                at = closer + bytes[closer..].iter().take_while(|b| **b == b'`').count();
                continue;
            }
        }
        let c = text[at..].chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `/\s+/g` to a single space.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `notificationText`: a compact plain-text preview for desktop and phone notifications. With `markdown` the
/// code blocks, link targets and emphasis marks go and white space collapses; either way the text is cut to 240
/// UTF-16 units at a word break, with `…`.
pub fn notification_text(value: Option<&str>, markdown: bool) -> String {
    let mut text = value.unwrap_or("").to_string();
    if markdown {
        text = replace_fences(&text);
        text = replace_links(&text, "!", 0);
        text = replace_links(&text, "", 1);
        text = strip_block_markers(&text);
        text = strip_double_marks(&text);
        text = strip_single_marks(&text);
        text = strip_inline_code(&text);
        text = collapse_whitespace(&text);
    }
    let text = js::trim(&text);
    if js::utf16_len(text) <= 240 {
        return text.to_string();
    }
    // text.slice(0, 239), without splitting a character.
    let mut cut = 0;
    let mut units = 0;
    for (index, c) in text.char_indices() {
        if units + c.len_utf16() > 239 {
            break;
        }
        units += c.len_utf16();
        cut = index + c.len_utf8();
    }
    let start = &text[..cut];
    let space = start.rfind(' ');
    // `space > 120` counts UTF-16 units before the space.
    let at_space = space.filter(|space| js::utf16_len(&start[..*space]) > 120);
    format!("{}\u{2026}", at_space.map_or(start, |space| &start[..space]))
}

/// A finished turn's notice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// `completionNotice`: the same chat-only title and result preview on desktop and phones.
pub fn completion_notice(title: Option<&str>, failed: bool, body: &str) -> Notice {
    let title = title.map(js::trim).filter(|title| !title.is_empty()).unwrap_or("Milagre").to_string();
    let text = notification_text(Some(&if failed { format!("Turn failed: {body}") } else { body.to_string() }), true);
    let body = if text.is_empty() { (if failed { "Turn failed." } else { "Turn completed." }).to_string() } else { text };
    Notice { title, body }
}

/// What a notice names about a Chat (`attentionContext`'s result, trimmed to what the notice reads).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttentionContext {
    pub chat_title: Option<String>,
    /// For a Subchat, the nearest Chat above it still listed.
    pub parent_title: Option<String>,
    pub provider: Option<Provider>,
}

/// `attentionTitle`: the title of a notice about a Chat that waits: a Subchat also says which Chat it belongs to.
pub fn attention_title(context: &AttentionContext) -> String {
    let title = context.chat_title.as_deref().map(js::trim).filter(|title| !title.is_empty()).unwrap_or("Milagre");
    match context.parent_title.as_deref().map(js::trim).filter(|parent| !parent.is_empty()) {
        Some(parent) => format!("{title} \u{b7} in {parent}"),
        None => title.to_string(),
    }
}

/// The agent events that ask for attention (`AgentEvent` of type `permission-request` or `question-request`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionEvent {
    PermissionRequest {
        title: String,
        command: Option<String>,
    },
    /// The texts of the questions asked, in order.
    QuestionRequest {
        questions: Vec<String>,
    },
    /// Any other event: no notice.
    Other,
}

/// `attentionNotice`: the notification for an approval or question a turn waits on, or `None` for any other event.
pub fn attention_notice(event: &AttentionEvent, context: &AttentionContext) -> Option<Notice> {
    let agent = context.provider.map_or("Agent", Provider::name);
    let title = attention_title(context);
    match event {
        AttentionEvent::Other => None,
        AttentionEvent::QuestionRequest { questions } => {
            let first = questions.first().map_or("Asked a question", String::as_str);
            let more = if questions.len() > 1 { format!(" (+{} more)", questions.len() - 1) } else { String::new() };
            Some(Notice { title, body: notification_text(Some(&format!("{agent} needs input: {first}{more}")), true) })
        }
        AttentionEvent::PermissionRequest { title: request_title, command } => {
            let command =
                command.as_deref().map(|command| js::trim(command.split('\n').next().unwrap_or(""))).filter(|command| !command.is_empty());
            let what = command.map_or_else(|| request_title.clone(), |command| format!("Run: {command}"));
            Some(Notice { title, body: notification_text(Some(&format!("{agent} needs approval: {what}")), command.is_none()) })
        }
    }
}

/// `attentionLabel`: names the waiting Chat, or counts Chats when the button opens a menu.
pub fn attention_label(titles: &[&str]) -> String {
    if titles.len() <= 1 {
        let name = titles.first().map(|title| js::trim(title)).filter(|title| !title.is_empty()).unwrap_or("Chat");
        return format!("{name} needs attention");
    }
    format!("{} Chats need attention", titles.len())
}

/// `attentionCount`: the attention chip's own short label: how many Chats wait, never their names.
pub fn attention_count(count: i64) -> String {
    format!("{} waiting", count.max(1))
}

/// A waiting run's approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitingApproval {
    pub title: String,
    pub command: Option<String>,
}

/// A run as `waitingFor` and `chatsNeedingAttention` read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WaitingRun {
    pub approvals: Vec<WaitingApproval>,
    /// For each question request, the texts of its questions.
    pub questions: Vec<Vec<String>>,
}

/// `waitingFor`: what a waiting run asks for, in one line: the approval's command or title, or its first question.
pub fn waiting_for(run: &WaitingRun) -> Option<String> {
    if let Some(approval) = run.approvals.first() {
        let command = approval
            .command
            .as_deref()
            .map(|command| js::trim(command.split('\n').next().unwrap_or("")))
            .filter(|command| !command.is_empty());
        return Some(command.map_or_else(|| approval.title.clone(), str::to_string));
    }
    run.questions.first().and_then(|questions| questions.first()).cloned()
}

const LINK_PREFIX: &str = "milagre-link:";
const LOCAL_COMPUTER: &str = "local";

/// `chat-scopes.mjs` `parts`: whether a key is a Link's, its computer, and the key without it.
fn key_parts(key: &str) -> (bool, &str, &str) {
    let link = key.starts_with(LINK_PREFIX);
    let rest = if link { &key[LINK_PREFIX.len()..] } else { key };
    if let Some((id, tail)) = rest.split_once('|')
        && (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && id != LOCAL_COMPUTER
    {
        return (link, id, tail);
    }
    (link, LOCAL_COMPUTER, rest)
}

/// `computerOfKey`.
fn computer_of_key(key: &str) -> &str {
    key_parts(key).1
}

/// `isLinkScopeKey`: a Link's key, with a well-formed Link id.
fn is_link_scope_key(key: &str) -> bool {
    if !key.starts_with(LINK_PREFIX) {
        return false;
    }
    let bare = key_parts(key).2;
    let groups: Vec<&str> = bare.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `projectOfKey`: the project path at the start of a chat key (before the last `#`).
fn project_of_key(key: &str) -> &str {
    key.rfind('#').map_or(key, |index| &key[..index])
}

/// `hiddenHere`: whether a Chat (or scope) key is left out of this computer's sidebar: its Project or Link is in
/// `scopes`, or its computer is in `computers` ("local" for this computer).
pub fn hidden_here(key: &str, scopes: &HashSet<String>, computers: &HashSet<String>) -> bool {
    let scope = project_of_key(key);
    scopes.contains(scope) || computers.contains(computer_of_key(scope))
}

/// `chatsNeedingAttention`: Chat keys other than `current` whose turn waits on an approval or question, in the
/// order given. Link Chats, the Projects in `hidden`, and computers in `hidden_computers` are left out.
pub fn chats_needing_attention(
    runs: &[(String, WaitingRun)],
    current: &str,
    hidden: &HashSet<String>,
    hidden_computers: &HashSet<String>,
) -> Vec<String> {
    runs.iter()
        .filter(|(key, run)| {
            (!run.approvals.is_empty() || !run.questions.is_empty())
                && !is_link_scope_key(project_of_key(key))
                && !hidden_here(key, hidden, hidden_computers)
                && key != current
        })
        .map(|(key, _)| key.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> AttentionContext {
        AttentionContext { chat_title: Some("Split the events table".into()), provider: Some(Provider::Claude), ..Default::default() }
    }

    fn questions(texts: &[&str]) -> AttentionEvent {
        AttentionEvent::QuestionRequest { questions: texts.iter().map(|t| t.to_string()).collect() }
    }

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn run(approvals: usize, questions: usize) -> WaitingRun {
        WaitingRun {
            approvals: (0..approvals).map(|_| WaitingApproval { title: String::new(), command: None }).collect(),
            questions: (0..questions).map(|_| vec![]).collect(),
        }
    }

    #[test]
    fn a_question_uses_only_the_chat_title_and_summarizes_what_it_asks() {
        let notice = attention_notice(&questions(&["Which table layout?", "Keep the old view?"]), &context()).unwrap();
        assert_eq!(
            notice,
            Notice { title: "Split the events table".into(), body: "Claude needs input: Which table layout? (+1 more)".into() }
        );
        assert_eq!(attention_notice(&questions(&[]), &context()).unwrap().body, "Claude needs input: Asked a question");
    }

    #[test]
    fn an_approval_shows_the_commands_first_line_or_the_requests_title() {
        let command = AttentionEvent::PermissionRequest { title: "Run this command?".into(), command: Some("npm test\n--watch".into()) };
        let codex = AttentionContext { provider: Some(Provider::Codex), ..context() };
        assert_eq!(
            attention_notice(&command, &codex),
            Some(Notice { title: "Split the events table".into(), body: "Codex needs approval: Run: npm test".into() })
        );
        let edit = AttentionEvent::PermissionRequest { title: "Edit App.tsx?".into(), command: None };
        assert_eq!(attention_notice(&edit, &context()).unwrap().body, "Claude needs approval: Edit App.tsx?");
        let no_agent = AttentionContext { provider: None, ..context() };
        assert_eq!(attention_notice(&edit, &no_agent).unwrap().body, "Agent needs approval: Edit App.tsx?");
    }

    #[test]
    fn a_missing_chat_title_never_falls_back_to_a_project_or_worktree_label() {
        assert_eq!(attention_notice(&questions(&["Ship it?"]), &AttentionContext::default()).unwrap().title, "Milagre");
    }

    #[test]
    fn a_subchats_notice_says_which_chat_it_belongs_to() {
        let sub = AttentionContext {
            chat_title: Some("Write pill tests".into()),
            parent_title: Some("Redesign the PR panel".into()),
            ..Default::default()
        };
        assert_eq!(attention_notice(&questions(&["Ship it?"]), &sub).unwrap().title, "Write pill tests \u{b7} in Redesign the PR panel");
        assert_eq!(
            attention_title(&AttentionContext { chat_title: Some("Tests".into()), parent_title: Some("  ".into()), provider: None }),
            "Tests"
        );
    }

    #[test]
    fn other_events_need_no_notification() {
        assert_eq!(attention_notice(&AttentionEvent::Other, &context()), None);
    }

    #[test]
    fn approval_previews_preserve_shell_patterns_and_filenames() {
        let command = "find . -name *test* && printf '%s' 'two   spaces' && rm -rf __pycache__";
        let event = AttentionEvent::PermissionRequest { title: "Run?".into(), command: Some(command.into()) };
        assert_eq!(attention_notice(&event, &context()).unwrap().body, format!("Claude needs approval: Run: {command}"));
    }

    #[test]
    fn notification_text_reads_markdown_as_plain_text() {
        let text = |value: &str| notification_text(Some(value), true);
        assert_eq!(
            text("Done: ```sh\nrm -rf /\n``` and `code` and **bold** and _it_ and ~~gone~~"),
            "Done: and code and bold and it and gone"
        );
        assert_eq!(text("See ![shot](a.png) and [the PR](https://x/1)."), "See shot and the PR.");
        assert_eq!(text("# Title\n- one\n- two\n1. three\n> quote"), "Title one two three quote");
        assert_eq!(text("a_b_c and snake_case_name and 2*3*4"), "a_b_c and snake_case_name and 2*3*4");
        assert_eq!(text("a/**b**/c and path/__x__"), "a/**b**/c and path/__x__");
        assert_eq!(text("(*note*) and *a b* and *a*."), "(*note*) and a b and a.");
        assert_eq!(text("  spaced \n\n out  "), "spaced out");
        assert_eq!(text("```unclosed\nstill code"), "");
        assert_eq!(text("```no newline```"), "no newline");
        assert_eq!(notification_text(Some("  **keep**  \n x "), false), "**keep**  \n x");
        assert_eq!(notification_text(None, true), "");
    }

    #[test]
    fn notification_text_is_cut_at_a_word_break() {
        let long = "word ".repeat(100);
        let cut = notification_text(Some(&long), true);
        assert!(cut.ends_with("word\u{2026}"), "{cut}");
        assert!(js::utf16_len(&cut) <= 240);
        let unbroken = "x".repeat(300);
        let cut = notification_text(Some(&unbroken), true);
        assert_eq!(js::utf16_len(&cut), 240);
        assert_eq!(notification_text(Some(&"x".repeat(240)), true).len(), 240);
        // A space too early (at 120 or before) is not used.
        let early = format!("{} {}", "a".repeat(100), "b".repeat(300));
        assert_eq!(js::utf16_len(&notification_text(Some(&early), true)), 240);
    }

    #[test]
    fn a_finished_turn_has_a_title_and_a_preview() {
        assert_eq!(
            completion_notice(Some("  Fix login "), false, "All **done**."),
            Notice { title: "Fix login".into(), body: "All done.".into() }
        );
        assert_eq!(completion_notice(None, true, "boom").body, "Turn failed: boom");
        assert_eq!(completion_notice(Some(" "), false, "").title, "Milagre");
        assert_eq!(completion_notice(None, false, "").body, "Turn completed.");
        assert_eq!(completion_notice(None, true, "").body, "Turn failed:");
    }

    #[test]
    fn waiting_chats_need_attention_including_the_same_project_the_open_chat_and_links_do_not() {
        let link = "milagre-link:12345678-1234-1234-1234-123456789abc#5".to_string();
        let runs = vec![
            ("/a#1".to_string(), run(1, 0)),
            ("/a#6".to_string(), run(0, 1)),
            ("/ab#2".to_string(), run(0, 1)),
            ("/b#3".to_string(), run(0, 0)),
            ("/c#4".to_string(), run(1, 0)),
            (link, run(1, 0)),
        ];
        assert_eq!(chats_needing_attention(&runs, "/a#1", &HashSet::new(), &HashSet::new()), vec!["/a#6", "/ab#2", "/c#4"]);
        assert_eq!(chats_needing_attention(&[], "", &HashSet::new(), &HashSet::new()), Vec::<String>::new());
    }

    #[test]
    fn a_project_hidden_from_the_sidebar_never_asks_for_attention() {
        let runs = vec![("/shop#1".to_string(), run(1, 0)), ("/gym#2".to_string(), run(0, 1))];
        assert_eq!(chats_needing_attention(&runs, "", &set(&["/gym"]), &HashSet::new()), vec!["/shop#1"]);
    }

    #[test]
    fn a_paired_computers_project_hidden_here_or_a_hidden_computer_never_asks_for_attention() {
        let runs = vec![
            ("/shop#1".to_string(), run(1, 0)),
            ("studio|/gym#2".to_string(), run(0, 1)),
            ("studio|/blog#3".to_string(), run(1, 0)),
            ("atlas|/api#4".to_string(), run(1, 0)),
        ];
        assert_eq!(
            chats_needing_attention(&runs, "", &set(&["studio|/gym"]), &set(&[])),
            vec!["/shop#1", "studio|/blog#3", "atlas|/api#4"]
        );
        assert_eq!(chats_needing_attention(&runs, "", &set(&[]), &set(&["studio"])), vec!["/shop#1", "atlas|/api#4"]);
        assert_eq!(
            chats_needing_attention(&runs, "", &set(&[]), &set(&["local"])),
            vec!["studio|/gym#2", "studio|/blog#3", "atlas|/api#4"]
        );
    }

    #[test]
    fn hidden_here_reads_a_chat_or_scope_key_against_hidden_projects_and_computers() {
        let none = set(&[]);
        assert!(hidden_here("studio|/gym#2", &set(&["studio|/gym"]), &none));
        assert!(hidden_here("studio|/gym", &set(&["studio|/gym"]), &none));
        assert!(!hidden_here("/gym#2", &set(&["studio|/gym"]), &none));
        assert!(hidden_here("studio|/gym#2", &none, &set(&["studio"])));
        assert!(hidden_here("/gym#2", &none, &set(&["local"])));
        assert!(!hidden_here("/gym#2", &none, &none));
    }

    #[test]
    fn the_attention_button_names_one_chat_and_counts_multiple_chats_even_with_duplicate_titles() {
        assert_eq!(attention_label(&[]), "Chat needs attention");
        assert_eq!(attention_label(&[""]), "Chat needs attention");
        assert_eq!(attention_label(&["Fix login"]), "Fix login needs attention");
        assert_eq!(attention_label(&["Fix login", "Fix login"]), "2 Chats need attention");
        assert_eq!(attention_label(&["Fix login", "Add API", "Update docs"]), "3 Chats need attention");
    }

    #[test]
    fn the_attention_chip_only_counts_the_waiting_chats() {
        assert_eq!(attention_count(1), "1 waiting");
        assert_eq!(attention_count(2), "2 waiting");
        assert_eq!(attention_count(0), "1 waiting");
    }

    #[test]
    fn a_waiting_run_reads_as_its_command_its_approval_title_or_its_first_question() {
        let approval = |title: &str, command: Option<&str>| WaitingRun {
            approvals: vec![WaitingApproval { title: title.into(), command: command.map(Into::into) }],
            questions: vec![],
        };
        assert_eq!(waiting_for(&approval("Run?", Some("git log --oneline\ngit status"))).as_deref(), Some("git log --oneline"));
        assert_eq!(waiting_for(&approval("Edit README.md", None)).as_deref(), Some("Edit README.md"));
        assert_eq!(
            waiting_for(&WaitingRun { approvals: vec![], questions: vec![vec!["Which branch?".into()]] }).as_deref(),
            Some("Which branch?")
        );
        assert_eq!(waiting_for(&WaitingRun::default()), None);
    }
}
