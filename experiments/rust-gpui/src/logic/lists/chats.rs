//! How a Chat is named, listed and pinned: the display parts of `packages/shared/src/chats.mjs`, with
//! `isChatListed`, `orderChats`, `dropIntent`, `formatLineCount` and `folderName` from
//! `apps/desktop/app/src/lib/chat-list.ts`.
//!
//! Not ported here: `createPendingChat`, `withPendingChat`, `pendingChatSessionId` and `withPreview` (optimistic
//! pending Chats belong with the outbox), and `chatMarkTone` and `chatMarkPresentation` (see `logic::marks`).

use std::cmp::Ordering;
use std::collections::HashMap;

use super::jsstr::{is_js_whitespace, js_trim, utf16_len, utf16_prefix};

/// A one-line title of at most 60 characters: a longer line keeps its first 57 and an ellipsis.
///
/// Counts UTF-16 code units like `String.length`. JavaScript's `slice(0, 57)` may cut a surrogate pair in half;
/// a Rust string cannot, so the whole character is dropped instead.
pub fn short_title(line: &str) -> String {
    if utf16_len(line) > 60 { format!("{}…", utf16_prefix(line, 57)) } else { line.to_owned() }
}

/// `[Image #N]` with N a positive integer: where `IMAGE_TOKEN` in `prompt-parts.mjs` matches, as the digits.
fn image_token_at(text: &str) -> Option<(usize, &str)> {
    let rest = text.strip_prefix("[Image #")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let (number, after) = rest.split_at(digits);
    if number.is_empty() || number.starts_with('0') || !after.starts_with(']') {
        return None;
    }
    Some(("[Image #".len() + digits + 1, number))
}

/// A Chat's name from the first line of its prompt (`promptTitle` in `prompt-parts.mjs`): the `[Image #N]`
/// tokens of attached images are dropped and the spaces collapsed, and a line that was only tokens reads
/// "Image" or "N images". `images` is the attached count; `None` (unknown) counts every token. A token with no
/// image behind it stays as text.
fn prompt_title(line: &str, images: Option<usize>) -> String {
    let mut found: Vec<&str> = Vec::new();
    let mut text = String::with_capacity(line.len());
    let mut at = 0;
    while at < line.len() {
        if let Some((len, number)) = image_token_at(&line[at..]) {
            let has_image = images.is_none_or(|count| number.parse::<f64>().is_ok_and(|index| index >= 1.0 && index <= count as f64));
            if has_image {
                if !found.contains(&number) {
                    found.push(number);
                }
            } else {
                text.push_str(&line[at..at + len]);
            }
            at += len;
            continue;
        }
        let c = line[at..].chars().next().unwrap_or('\0');
        text.push(c);
        at += c.len_utf8();
    }
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let text = js_trim(&collapsed).to_owned();
    if !text.is_empty() || found.is_empty() {
        return text;
    }
    if found.len() == 1 { "Image".to_owned() } else { format!("{} images", found.len()) }
}

/// What `chatTitle` reads from a Chat's saved summary (`session.summary`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TitleSummary<'a> {
    pub title_line: Option<&'a str>,
    /// The images the first message carried; `None` for a summary kept before it counted them.
    pub title_images: Option<usize>,
}

/// What `chatTitle` reads from a Chat (`AgentSession`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TitleSession<'a> {
    pub title: Option<&'a str>,
    pub generated_title: Option<&'a str>,
    pub summary: Option<TitleSummary<'a>>,
    /// The agent's name, the title of last resort.
    pub agent_name: &'a str,
}

/// A message, for the Chats whose host keeps no summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TitleMessage<'a> {
    pub is_assistant: bool,
    pub body: &'a str,
    /// How many images the message carries.
    pub images: usize,
}

/// The Chat's name: the one the user gave it, else the first line of its first message (from its summary when it
/// has one), with image tokens named.
pub fn chat_title(session: &TitleSession, messages: &[TitleMessage]) -> String {
    for own in [session.title, session.generated_title].into_iter().flatten() {
        let trimmed = js_trim(own);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    let line = match session.summary {
        Some(summary) => prompt_title(summary.title_line.unwrap_or(""), summary.title_images),
        None => {
            let first = messages.iter().find(|message| !message.is_assistant && !js_trim(message.body).is_empty());
            match first {
                Some(message) => prompt_title(js_trim(message.body).split('\n').next().unwrap_or(""), Some(message.images)),
                None => prompt_title("", Some(0)),
            }
        }
    };
    if line.is_empty() { session.agent_name.to_owned() } else { short_title(&line) }
}

/// What the list rules read from a Chat's routine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoutineHidden {
    /// `routine.hidden`; absent on a Run Chat saved before Run Chats could be hidden.
    pub hidden: Option<bool>,
}

/// What `isListedChat` reads from a Chat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ListSession {
    /// `handoverPending`.
    pub handover_pending: bool,
    /// `handoverDraft !== undefined`.
    pub has_handover_draft: bool,
    /// `routine`, when the Chat was made by a Routine's Run.
    pub routine: Option<RoutineHidden>,
}

/// A legacy handover Chat (before in-place handoff) that is still being prepared or holds its brief as a draft:
/// a live, provider-locked Chat even with no messages.
pub fn is_handover_chat(session: &ListSession) -> bool {
    session.handover_pending || session.has_handover_draft
}

/// A Chat a Routine's Run created and keeps out of the lists: hidden, and not waiting on an approval or question.
pub fn is_hidden_run_chat(session: &ListSession, waiting: bool) -> bool {
    session.routine.is_some_and(|routine| routine.hidden == Some(true)) && !waiting
}

/// The Chat lists show a Chat once it has a message, or while a handover prepares it; a Worktree's empty starter
/// Chat stays out. A hidden Run Chat stays out too, unless `waiting` says it waits on an approval or question.
/// `message_count` is the summary's `count` (`isChatListed` in `chat-list.ts` reads it from there).
pub fn is_listed_chat(session: &ListSession, message_count: usize, waiting: bool) -> bool {
    if is_hidden_run_chat(session, waiting) {
        return false;
    }
    message_count > 0 || is_handover_chat(session)
}

/// What `comparePins` reads from a Chat.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PinOrder {
    pub pinned: bool,
    pub pin_order: Option<f64>,
}

/// Sorts pinned Chats first, in their manual order; `Equal` for two unpinned Chats, so the list's own order
/// decides those.
pub fn compare_pins(a: PinOrder, b: PinOrder) -> Ordering {
    if a.pinned != b.pinned {
        return if a.pinned { Ordering::Less } else { Ordering::Greater };
    }
    if a.pinned {
        let difference = a.pin_order.unwrap_or(0.0) - b.pin_order.unwrap_or(0.0);
        // `NaN` is neither before nor after, as in a JavaScript comparator.
        return difference.partial_cmp(&0.0).unwrap_or(Ordering::Equal);
    }
    Ordering::Equal
}

/// The `pin_order` that puts a Chat at `index` among pinned Chats whose orders are `orders`, lowest first.
pub fn pin_order_at(orders: &[f64], index: usize) -> f64 {
    let before = index.checked_sub(1).and_then(|at| orders.get(at));
    let after = orders.get(index);
    match (before, after) {
        (None, None) => 0.0,
        (None, Some(after)) => after - 1.0,
        (Some(before), None) => before + 1.0,
        (Some(before), Some(after)) => (before + after) / 2.0,
    }
}

/// Remembers the `clientMessageId` of a send that failed before the host answered, with what was put back in the
/// composer (`createResendMemory`). The host may have saved that message and lost only the answer, so the same text
/// sent again reuses the id and the host recognises it instead of running it twice. Keyed by the composer (a Chat,
/// or the new-Chat view).
#[derive(Debug, Default)]
pub struct ResendMemory {
    failed: HashMap<String, (String, String)>,
}

fn send_signature(body: &str, attachments: &[&str]) -> String {
    // `JSON.stringify([body, ...attachments])`: a canonical form of the same list.
    let mut parts = vec![json_string(body)];
    parts.extend(attachments.iter().map(|item| json_string(item)));
    format!("[{}]", parts.join(","))
}

/// `JSON.stringify` of a string.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl ResendMemory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keeps `client_message_id` for the next send of the same body and attachments from `key`.
    pub fn remember(&mut self, key: &str, client_message_id: &str, body: &str, attachments: &[&str]) {
        self.failed.insert(key.to_owned(), (client_message_id.to_owned(), send_signature(body, attachments)));
    }

    /// The id to resend with, or `None` for a fresh message. Anything that differs from the failed send forgets it.
    pub fn reuse(&mut self, key: &str, body: &str, attachments: &[&str]) -> Option<String> {
        let (id, signature) = self.failed.get(key)?;
        if *signature == send_signature(body, attachments) {
            return Some(id.clone());
        }
        self.failed.remove(key);
        None
    }

    /// The send went through.
    pub fn forget(&mut self, key: &str) {
        self.failed.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(agent_name: &str) -> TitleSession<'_> {
        TitleSession { title: None, generated_title: None, summary: None, agent_name }
    }

    fn user(body: &str, images: usize) -> TitleMessage<'_> {
        TitleMessage { is_assistant: false, body, images }
    }

    #[test]
    fn short_title_keeps_60_whole_and_cuts_longer_to_57_and_an_ellipsis() {
        assert_eq!(short_title("CI green"), "CI green");
        assert_eq!(short_title(&"x".repeat(60)), "x".repeat(60));
        assert_eq!(short_title(&"x".repeat(61)), format!("{}…", "x".repeat(57)));
        assert_eq!(short_title(&"x".repeat(61)).chars().count(), 58);
    }

    #[test]
    fn title_prefers_the_users_name_then_the_first_messages_first_line() {
        let messages = [user("", 0), user("Fix the login\nand more", 0)];
        assert_eq!(chat_title(&session("main"), &messages), "Fix the login");
        assert_eq!(chat_title(&TitleSession { title: Some("  Login bug "), ..session("main") }, &messages), "Login bug");
        assert_eq!(chat_title(&TitleSession { title: Some("   "), ..session("main") }, &messages), "Fix the login");
        assert_eq!(chat_title(&TitleSession { generated_title: Some(" Generated "), ..session("main") }, &messages), "Generated");
        assert_eq!(chat_title(&session("main"), &[]), "main");
        let long = "x".repeat(80);
        assert_eq!(chat_title(&session("main"), &[user(&long, 0)]), format!("{}…", "x".repeat(57)));
        // An assistant message never names a Chat.
        let reply = TitleMessage { is_assistant: true, body: "Hello", images: 0 };
        assert_eq!(chat_title(&session("main"), &[reply]), "main");
    }

    #[test]
    fn title_names_an_image_only_prompt_and_drops_image_tokens() {
        let title = |body: &str, images: usize| chat_title(&session("main"), &[user(body, images)]);
        assert_eq!(title("[Image #1]", 1), "Image");
        assert_eq!(title("[Image #1] [Image #2]", 2), "2 images");
        assert_eq!(title("look at [Image #1]   please", 1), "look at please");
        assert_eq!(title("[Image #3]", 1), "[Image #3]");
        assert_eq!(title("[Image #1]", 0), "[Image #1]");
        let summarized = |title_line: &str, title_images: Option<usize>| {
            chat_title(&TitleSession { summary: Some(TitleSummary { title_line: Some(title_line), title_images }), ..session("main") }, &[])
        };
        assert_eq!(summarized("[Image #1]", Some(1)), "Image");
        assert_eq!(summarized("[Image #1] [Image #2]", None), "2 images");
        assert_eq!(summarized("[Image #2]", Some(1)), "[Image #2]");
        let mine = TitleSession {
            title: Some("Mine"),
            summary: Some(TitleSummary { title_line: Some("[Image #1]"), title_images: Some(1) }),
            ..session("main")
        };
        assert_eq!(chat_title(&mine, &[]), "Mine");
        // A summary without a line falls back to the agent's name, and ignores messages.
        let empty = TitleSession { summary: Some(TitleSummary::default()), ..session("main") };
        assert_eq!(chat_title(&empty, &[user("ignored", 0)]), "main");
    }

    #[test]
    fn image_tokens_need_a_positive_integer_and_the_same_image_counts_once() {
        let title = |body: &str, images: Option<usize>| prompt_title(body, images);
        assert_eq!(title("[Image #0]", None), "[Image #0]");
        assert_eq!(title("[Image #01]", None), "[Image #01]");
        assert_eq!(title("[Image #]", None), "[Image #]");
        assert_eq!(title("[Image #1][Image #1]", None), "Image");
        assert_eq!(title("[Image #10] a", Some(10)), "a");
        assert_eq!(title("  é [Image #1]\t\u{a0} ü ", None), "é ü");
    }

    #[test]
    fn lists_hide_the_empty_starter_chat_but_keep_chats_with_messages_and_handovers() {
        let none = ListSession::default();
        assert!(!is_listed_chat(&none, 0, false));
        assert!(is_listed_chat(&none, 2, false));
        assert!(is_listed_chat(&ListSession { handover_pending: true, ..none }, 0, false));
        assert!(is_listed_chat(&ListSession { has_handover_draft: true, ..none }, 0, false));
    }

    #[test]
    fn a_hidden_run_chat_is_left_out_until_it_waits_on_someone() {
        let routine = |hidden| ListSession { routine: Some(RoutineHidden { hidden }), ..ListSession::default() };
        let hidden = routine(Some(true));
        assert!(is_hidden_run_chat(&hidden, false));
        assert!(!is_hidden_run_chat(&hidden, true));
        assert!(!is_hidden_run_chat(&ListSession::default(), false));
        assert!(!is_listed_chat(&hidden, 3, false));
        assert!(is_listed_chat(&hidden, 3, true));
        assert!(is_listed_chat(&routine(Some(false)), 3, false));
        // Made before hiding existed.
        assert!(is_listed_chat(&routine(None), 3, false));
        // Waiting lists nothing that has nothing to show.
        assert!(!is_listed_chat(&hidden, 0, true));
    }

    #[test]
    fn compare_pins_puts_pinned_first_in_their_order_and_leaves_the_rest_alone() {
        let pin = |pinned, order| PinOrder { pinned, pin_order: order };
        // (id, order) as in the TS test: 1 plain, 2 pinned 5, 3 plain, 4 pinned -1, 5 plain with a stale order.
        let mut chats = [
            (1, pin(false, None)),
            (2, pin(true, Some(5.0))),
            (3, pin(false, None)),
            (4, pin(true, Some(-1.0))),
            (5, pin(false, Some(-9.0))),
        ];
        chats.sort_by(|a, b| compare_pins(a.1, b.1));
        assert_eq!(chats.map(|chat| chat.0), [4, 2, 1, 3, 5]);
        // A pinned Chat without an order counts as 0.
        assert_eq!(compare_pins(pin(true, None), pin(true, Some(1.0))), Ordering::Less);
        assert_eq!(compare_pins(pin(true, Some(f64::NAN)), pin(true, Some(1.0))), Ordering::Equal);
    }

    #[test]
    fn pin_order_at_fits_between_before_or_after_the_pinned_ones() {
        assert_eq!(pin_order_at(&[], 0), 0.0);
        assert_eq!(pin_order_at(&[2.0, 4.0], 0), 1.0);
        assert_eq!(pin_order_at(&[2.0, 4.0], 1), 3.0);
        assert_eq!(pin_order_at(&[2.0, 4.0], 2), 5.0);
        assert_eq!(pin_order_at(&[2.0, 3.0], 1), 2.5);
    }

    #[test]
    fn a_resend_of_the_same_text_reuses_the_failed_sends_client_id() {
        let mut memory = ResendMemory::new();
        assert_eq!(memory.reuse("chat", "Hello", &[]), None);
        memory.remember("chat", "id-1", "Hello", &["a"]);
        assert_eq!(memory.reuse("other", "Hello", &["a"]), None);
        assert_eq!(memory.reuse("chat", "Hello", &["a"]), Some("id-1".to_owned()));
        // Still remembered until something differs.
        assert_eq!(memory.reuse("chat", "Hello", &["a"]), Some("id-1".to_owned()));
        assert_eq!(memory.reuse("chat", "Hello", &["b"]), None);
        assert_eq!(memory.reuse("chat", "Hello", &["a"]), None, "a different send forgets it");
        memory.remember("chat", "id-2", "Hi \"there\"\n", &[]);
        memory.forget("chat");
        assert_eq!(memory.reuse("chat", "Hi \"there\"\n", &[]), None);
    }

    #[test]
    fn signatures_tell_a_body_from_an_attachment() {
        assert_ne!(send_signature("a", &["b"]), send_signature("a,b", &[]));
        assert_eq!(send_signature("a\"\n", &["\u{1}"]), "[\"a\\\"\\n\",\"\\u0001\"]");
    }
}
