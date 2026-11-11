//! How the sidebar orders Chats and what dropping one does, with the small formatters beside them
//! (`orderChats`, `dropIntent`, `formatLineCount` and `folderName` in `apps/desktop/app/src/lib/chat-list.ts`).

use super::chats::{PinOrder, compare_pins};

/// How the sidebar orders Chats: by when they started, or by their latest message. Newest first either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatOrder {
    Created,
    Recent,
}

/// What `orderChats` reads from a Chat: its pin, and the ids of its first and last message from its summary
/// (`chatSummary`). Message ids only grow, so the first message dates a Chat's start and the last its latest
/// activity.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChatSortKey {
    pub pin: PinOrder,
    pub first_id: Option<i64>,
    pub last_id: Option<i64>,
}

/// Pinned Chats first, in their manual order, so a finishing turn never moves them; then the rest newest first.
/// Returns a new list and leaves `chats` as it was; Chats that tie keep their given order.
pub fn order_chats<T: Clone>(chats: &[T], order: ChatOrder, key_of: impl Fn(&T) -> ChatSortKey) -> Vec<T> {
    let activity = |chat: &T| {
        let key = key_of(chat);
        (if order == ChatOrder::Recent { key.last_id } else { key.first_id }).unwrap_or(0)
    };
    let mut sorted = chats.to_vec();
    sorted.sort_by(|a, b| compare_pins(key_of(a).pin, key_of(b).pin).then_with(|| activity(b).cmp(&activity(a))));
    sorted
}

/// Where a dragged Chat lands on a row: on the line above or below it, or on the row itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropZone {
    Before,
    After,
    On,
}

/// Why dropping a Chat on a row does nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidDrop {
    SameWorktree,
    /// A Link already joins the two Chats' Worktrees.
    Linked,
}

/// What dropping does. `Link` links the two Chats' Worktrees; `None` leaves everything as it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropIntent {
    Reorder,
    Pin,
    Unpin,
    Link,
    None,
    Invalid(InvalidDrop),
}

/// A Chat in a drag: whether it is pinned and its Worktree's path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DropChat<'a> {
    pub pinned: bool,
    pub worktree: Option<&'a str>,
}

/// What dropping `source` at `zone` of `target` does. A `None` target is the empty Pinned section.
/// `linked`: a Link already joins the two Chats' Worktrees.
pub fn drop_intent(source: DropChat, target: Option<DropChat>, zone: DropZone, linked: bool) -> DropIntent {
    let Some(target) = target else {
        return if source.pinned { DropIntent::None } else { DropIntent::Pin };
    };
    if zone == DropZone::On {
        // `source.worktree && source.worktree === target.worktree`: an empty path is falsy.
        if source.worktree.is_some_and(|worktree| !worktree.is_empty()) && source.worktree == target.worktree {
            return DropIntent::Invalid(InvalidDrop::SameWorktree);
        }
        return if linked { DropIntent::Invalid(InvalidDrop::Linked) } else { DropIntent::Link };
    }
    if target.pinned {
        return if source.pinned { DropIntent::Reorder } else { DropIntent::Pin };
    }
    if source.pinned { DropIntent::Unpin } else { DropIntent::None }
}

/// JavaScript's `Number.prototype.toFixed(1)` for a finite value in `[0, 10)`: the nearest tenth, a tie going up.
/// Rust's `{:.1}` rounds an exact tie to even (2.25 prints "2.2"; JavaScript gives "2.3").
fn to_fixed_1(value: f64) -> String {
    // An exact tie (x.25 or x.75) is the only case where the two disagree, and only a multiple of a quarter
    // can be one: it is exactly representable, so `value * 4` is exact.
    let quarters = value * 4.0;
    if quarters.fract() == 0.0 && quarters % 2.0 != 0.0 {
        return format!("{:.1}", ((value * 10.0) + 0.5).floor() / 10.0);
    }
    format!("{value:.1}")
}

/// `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn trim_decimal(value: f64) -> String {
    if value < 10.0 { to_fixed_1(value).trim_end_matches(".0").to_owned() } else { format!("{}", js_round(value)) }
}

/// A line count in a few characters: 980, 2.1k, 14k, 2.1m.
pub fn format_line_count(count: f64) -> String {
    if count < 1000.0 {
        // `String(count)`
        return format!("{count}");
    }
    if count < 1_000_000.0 {
        return format!("{}k", trim_decimal(count / 1000.0));
    }
    format!("{}m", trim_decimal(count / 1_000_000.0))
}

/// The folder name at the end of a path (either separator, trailing ones ignored); the whole path when nothing is left.
pub fn folder_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let last = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    if last.is_empty() { path } else { last }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug)]
    struct Chat {
        name: &'static str,
        pin: PinOrder,
        ids: Vec<i64>,
    }

    fn chat(name: &'static str, ids: &[i64]) -> Chat {
        Chat { name, pin: PinOrder::default(), ids: ids.to_vec() }
    }

    fn pinned(name: &'static str, ids: &[i64], order: f64) -> Chat {
        Chat { name, pin: PinOrder { pinned: true, pin_order: Some(order) }, ids: ids.to_vec() }
    }

    fn key(chat: &Chat) -> ChatSortKey {
        ChatSortKey { pin: chat.pin, first_id: chat.ids.first().copied(), last_id: chat.ids.last().copied() }
    }

    fn names(chats: &[Chat]) -> Vec<&'static str> {
        chats.iter().map(|chat| chat.name).collect()
    }

    #[test]
    fn format_line_count_reads_short() {
        for (count, text) in [
            (0.0, "0"),
            (980.0, "980"),
            (1000.0, "1k"),
            (2140.0, "2.1k"),
            (14_400.0, "14k"),
            (2_100_000.0, "2.1m"),
            // JavaScript rounds the exact tie 2.25 up to 2.3, where Rust's default rounds to even.
            (2250.0, "2.3k"),
            (2750.0, "2.8k"),
            // 9.95 is 9.949999... as a double: toFixed(1) gives 9.9.
            (9950.0, "9.9k"),
            (9960.0, "10k"),
            (999_500.0, "1000k"),
            (10_500.0, "11k"),
            (1_000_000.0, "1m"),
        ] {
            assert_eq!(format_line_count(count), text, "{count}");
        }
    }

    #[test]
    fn folder_name_is_the_last_segment() {
        assert_eq!(folder_name("/Users/v/.milagre/worktrees/app/fix-login-ab12/"), "fix-login-ab12");
        assert_eq!(folder_name("/"), "/");
        assert_eq!(folder_name("C:\\code\\app\\"), "app");
        assert_eq!(folder_name("plain"), "plain");
        assert_eq!(folder_name(""), "");
    }

    #[test]
    fn order_chats_sorts_newest_first_by_start_or_latest_message() {
        let chats = [chat("old but active", &[1, 9]), chat("newest", &[7, 8]), chat("middle", &[4, 5])];
        assert_eq!(names(&order_chats(&chats, ChatOrder::Created, key)), ["newest", "middle", "old but active"]);
        assert_eq!(names(&order_chats(&chats, ChatOrder::Recent, key)), ["old but active", "newest", "middle"]);
        assert_eq!(names(&chats), ["old but active", "newest", "middle"]);
    }

    #[test]
    fn order_chats_keeps_pinned_on_top_in_their_own_order() {
        let chats = [chat("busy", &[1, 99]), pinned("second pin", &[2], 1.0), pinned("first pin", &[3, 98], 0.0), chat("quiet", &[4])];
        assert_eq!(names(&order_chats(&chats, ChatOrder::Recent, key)), ["first pin", "second pin", "busy", "quiet"]);
        assert_eq!(names(&order_chats(&chats, ChatOrder::Created, key)), ["first pin", "second pin", "quiet", "busy"]);
    }

    #[test]
    fn order_chats_follows_summaries_that_hold_no_messages() {
        // The TS test's two Chats, from their summaries alone, before and after a send is saved.
        let summary = |name, first, last| Chat { name, pin: PinOrder::default(), ids: vec![first, last] };
        let saved = [summary("one", 3, 100), summary("ten", 12, 60)];
        assert_eq!(names(&order_chats(&saved, ChatOrder::Created, key)), ["ten", "one"]);
        assert_eq!(names(&order_chats(&saved, ChatOrder::Recent, key)), ["one", "ten"]);
    }

    #[test]
    fn a_chat_without_messages_counts_as_zero_and_ties_keep_their_order() {
        let chats = [chat("a", &[]), chat("b", &[]), chat("c", &[1])];
        assert_eq!(names(&order_chats(&chats, ChatOrder::Recent, key)), ["c", "a", "b"]);
    }

    #[test]
    fn drop_intent_between_rows_pins_unpins_or_reorders_and_on_a_row_links_other_worktrees() {
        let pinned = DropChat { pinned: true, worktree: Some("/a") };
        let recent = DropChat { pinned: false, worktree: Some("/b") };
        let other = |worktree| DropChat { pinned: false, worktree: Some(worktree) };
        assert_eq!(drop_intent(recent, None, DropZone::Before, false), DropIntent::Pin);
        assert_eq!(drop_intent(pinned, None, DropZone::Before, false), DropIntent::None);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::After, false), DropIntent::Pin);
        assert_eq!(
            drop_intent(pinned, Some(DropChat { pinned: true, worktree: Some("/c") }), DropZone::Before, false),
            DropIntent::Reorder
        );
        assert_eq!(drop_intent(pinned, Some(recent), DropZone::Before, false), DropIntent::Unpin);
        assert_eq!(drop_intent(recent, Some(other("/c")), DropZone::After, false), DropIntent::None);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::On, false), DropIntent::Link);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::On, true), DropIntent::Invalid(InvalidDrop::Linked));
        assert_eq!(drop_intent(recent, Some(other("/b")), DropZone::On, false), DropIntent::Invalid(InvalidDrop::SameWorktree));
        // No Worktree on the source never matches.
        let loose = DropChat::default();
        assert_eq!(drop_intent(loose, Some(DropChat::default()), DropZone::On, false), DropIntent::Link);
    }
}
