//! Done: the light way to put a Chat away (`packages/shared/src/done.mjs`). Marking a Chat Done moves it to the
//! Done list at the bottom of the sidebar at once; the host archives it once it has been Done for the retention
//! the user picked.

use std::cmp::Ordering;

use super::raw::Raw;

const HOUR_MS: i64 = 60 * 60 * 1000;

/// The retention choices in hours, in the order Settings lists them; 0 is Never.
pub const DONE_RETENTION_OPTIONS: [u32; 6] = [1, 8, 24, 72, 168, 0];

/// `DONE_DEFAULTS.retentionHours`.
pub const DONE_DEFAULT_RETENTION_HOURS: u32 = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoneSettings {
    pub retention_hours: u32,
}

/// The settings with anything unknown back at its default: only a number in [`DONE_RETENTION_OPTIONS`] is kept.
pub fn normalize_done_settings(value: &Raw) -> DoneSettings {
    let hours = value.get("retentionHours").and_then(Raw::as_f64);
    let retention_hours = DONE_RETENTION_OPTIONS.iter().copied().find(|option| hours == Some(f64::from(*option)));
    DoneSettings { retention_hours: retention_hours.unwrap_or(DONE_DEFAULT_RETENTION_HOURS) }
}

/// "1 hour", "24 hours", "3 days", "1 week", "Never".
pub fn retention_label(hours: u32) -> String {
    if hours == 0 {
        return "Never".to_owned();
    }
    if hours == 168 {
        return "1 week".to_owned();
    }
    if hours.is_multiple_of(24) && hours > 24 {
        return format!("{} days", hours / 24);
    }
    if hours == 1 { "1 hour".to_owned() } else { format!("{hours} hours") }
}

/// What the Done rules read from a Chat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DoneChat {
    /// When it was marked Done, in ms; `None` (or 0) when it is not.
    pub done_at: Option<i64>,
    pub archived: bool,
}

/// Whether a Chat is in the Done list: marked Done and not archived yet.
pub fn is_done(chat: &DoneChat) -> bool {
    chat.done_at.is_some_and(|at| at != 0) && !chat.archived
}

/// When a Done Chat is archived, in ms; `None` when it never is (Never, or not Done).
pub fn done_due_at(chat: &DoneChat, retention_hours: u32) -> Option<i64> {
    if !is_done(chat) || retention_hours == 0 {
        return None;
    }
    chat.done_at.map(|at| at + i64::from(retention_hours) * HOUR_MS)
}

/// Whether the host's sweep archives this Chat now.
pub fn done_due(chat: &DoneChat, retention_hours: u32, now: i64) -> bool {
    done_due_at(chat, retention_hours).is_some_and(|due| due <= now)
}

/// The countdown a Done row shows until it is archived, as hours:minutes ("21:14", "0:42"); `None` when it never is.
pub fn done_countdown(chat: &DoneChat, retention_hours: u32, now: i64) -> Option<String> {
    let due = done_due_at(chat, retention_hours)?;
    // A clock read just before the Mac stamped it (a phone's, a minute tick behind) never shows more than the
    // retention.
    let left = ((due - now) as f64 / 60_000.0).ceil().max(0.0) as i64;
    let minutes = left.min(i64::from(retention_hours) * 60);
    Some(format!("{}:{:02}", minutes / 60, minutes % 60))
}

/// Done Chats, most recently marked first: the order the Done list shows them in.
pub fn by_done_at(a: Option<i64>, b: Option<i64>) -> Ordering {
    b.unwrap_or(0).cmp(&a.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(fields: Vec<(&str, Raw)>) -> Raw {
        Raw::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
    }

    fn retention(value: Raw) -> u32 {
        normalize_done_settings(&settings(vec![("retentionHours", value)])).retention_hours
    }

    #[test]
    fn settings_keep_a_listed_retention_and_fall_back_to_24_hours() {
        assert_eq!(normalize_done_settings(&Raw::Null).retention_hours, 24);
        assert_eq!(normalize_done_settings(&Raw::Array(vec![])).retention_hours, 24);
        assert_eq!(normalize_done_settings(&settings(vec![])).retention_hours, 24);
        assert_eq!(retention(Raw::Number(72.0)), 72);
        assert_eq!(retention(Raw::Number(0.0)), 0);
        assert_eq!(retention(Raw::Number(5.0)), 24);
        assert_eq!(retention(Raw::Str("24".into())), 24);
        assert_eq!(retention(Raw::Number(f64::NAN)), 24);
    }

    #[test]
    fn each_retention_reads_as_settings_lists_it() {
        let labels: Vec<String> = DONE_RETENTION_OPTIONS.iter().map(|hours| retention_label(*hours)).collect();
        assert_eq!(labels, ["1 hour", "8 hours", "24 hours", "3 days", "1 week", "Never"]);
        assert_eq!(retention_label(48), "2 days");
    }

    #[test]
    fn a_done_chat_is_due_once_its_retention_has_passed() {
        let at = 1_000_000;
        let chat = DoneChat { done_at: Some(at), archived: false };
        assert!(is_done(&chat));
        assert!(!done_due(&chat, 24, at + 24 * HOUR_MS - 1));
        assert!(done_due(&chat, 24, at + 24 * HOUR_MS));
        assert!(!done_due(&chat, 0, at + 1000 * HOUR_MS), "Never");
        assert!(!done_due(&DoneChat { archived: true, ..chat }, 1, at + 2 * HOUR_MS));
        assert!(!done_due(&DoneChat::default(), 1, at + 2 * HOUR_MS));
        assert!(!is_done(&DoneChat { done_at: Some(0), archived: false }));
    }

    #[test]
    fn the_countdown_reads_hours_minutes_left_rounds_up_and_stops_at_zero() {
        let at = 1_000;
        let chat = DoneChat { done_at: Some(at), archived: false };
        assert_eq!(done_countdown(&chat, 24, at + 2 * HOUR_MS + 46 * 60_000 - 30_000).as_deref(), Some("21:15"));
        assert_eq!(done_countdown(&chat, 1, at + 18 * 60_000).as_deref(), Some("0:42"));
        assert_eq!(done_countdown(&chat, 1, at + 5 * HOUR_MS).as_deref(), Some("0:00"));
        assert_eq!(done_countdown(&chat, 0, at), None);
        assert_eq!(done_countdown(&chat, 24, at - 90_000).as_deref(), Some("24:00"), "a clock behind the Mac's");
        assert_eq!(done_countdown(&DoneChat::default(), 24, at), None);
    }

    #[test]
    fn the_done_list_shows_the_most_recently_marked_first() {
        let mut list = [Some(1), Some(3), None, Some(2)];
        list.sort_by(|a, b| by_done_at(*a, *b));
        assert_eq!(list, [Some(3), Some(2), Some(1), None]);
    }
}
