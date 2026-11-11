//! What a Chat row's second line can show, chosen in the sidebar's Filters menu (desktop) and the project list's
//! (phone) (`packages/shared/src/chat-row.ts`). Each device keeps its own choice.

use super::raw::Raw;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChatRowField {
    Computer,
    PullRequests,
    LinearIssue,
    Branch,
    Diff,
    LastActivity,
}

impl ChatRowField {
    /// The key a saved choice stores it under (`ChatRowField`'s string).
    pub fn id(self) -> &'static str {
        match self {
            ChatRowField::Computer => "computer",
            ChatRowField::PullRequests => "pullRequests",
            ChatRowField::LinearIssue => "linearIssue",
            ChatRowField::Branch => "branch",
            ChatRowField::Diff => "diff",
            ChatRowField::LastActivity => "lastActivity",
        }
    }
}

/// In the menu's order. `Computer` is offered only with two or more computers, so the phone never lists it.
pub const CHAT_ROW_FIELDS: [(ChatRowField, &str); 6] = [
    (ChatRowField::Computer, "Computer"),
    (ChatRowField::PullRequests, "Pull requests"),
    (ChatRowField::LinearIssue, "Linear issue"),
    (ChatRowField::Branch, "Branch"),
    (ChatRowField::Diff, "Diff stats"),
    (ChatRowField::LastActivity, "Last activity"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatRowShow {
    pub computer: bool,
    pub pull_requests: bool,
    pub linear_issue: bool,
    pub branch: bool,
    pub diff: bool,
    pub last_activity: bool,
}

impl ChatRowShow {
    pub fn get(&self, field: ChatRowField) -> bool {
        *self.slot(field)
    }

    fn slot(&self, field: ChatRowField) -> &bool {
        match field {
            ChatRowField::Computer => &self.computer,
            ChatRowField::PullRequests => &self.pull_requests,
            ChatRowField::LinearIssue => &self.linear_issue,
            ChatRowField::Branch => &self.branch,
            ChatRowField::Diff => &self.diff,
            ChatRowField::LastActivity => &self.last_activity,
        }
    }

    fn slot_mut(&mut self, field: ChatRowField) -> &mut bool {
        match field {
            ChatRowField::Computer => &mut self.computer,
            ChatRowField::PullRequests => &mut self.pull_requests,
            ChatRowField::LinearIssue => &mut self.linear_issue,
            ChatRowField::Branch => &mut self.branch,
            ChatRowField::Diff => &mut self.diff,
            ChatRowField::LastActivity => &mut self.last_activity,
        }
    }
}

/// What the rows showed before the choice existed: desktop the computer and the chips, the phone its branch too.
pub const DESKTOP_CHAT_ROW_SHOW: ChatRowShow =
    ChatRowShow { computer: true, pull_requests: true, linear_issue: true, branch: false, diff: false, last_activity: false };
pub const PHONE_CHAT_ROW_SHOW: ChatRowShow = ChatRowShow { branch: true, ..DESKTOP_CHAT_ROW_SHOW };

/// A saved choice, field by field, with `fallback` for anything missing or malformed.
pub fn parse_chat_row_show(value: &Raw, fallback: ChatRowShow) -> ChatRowShow {
    let mut show = fallback;
    for (field, _) in CHAT_ROW_FIELDS {
        if let Some(saved) = value.get(field.id()).and_then(Raw::as_bool) {
            *show.slot_mut(field) = saved;
        }
    }
    show
}

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;

/// A row's last activity, short: "now", "5m", "3h", "2d", "6w". Both are timestamps in ms.
pub fn activity_ago(at: f64, now: f64) -> String {
    let elapsed = (now - at).max(0.0);
    if elapsed < MINUTE {
        "now".to_owned()
    } else if elapsed < HOUR {
        format!("{}m", (elapsed / MINUTE).floor())
    } else if elapsed < DAY {
        format!("{}h", (elapsed / HOUR).floor())
    } else if elapsed < 7.0 * DAY {
        format!("{}d", (elapsed / DAY).floor())
    } else {
        format!("{}w", (elapsed / (7.0 * DAY)).floor())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(fields: Vec<(&str, Raw)>) -> Raw {
        Raw::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
    }

    #[test]
    fn a_saved_choice_keeps_its_booleans_and_falls_back_field_by_field() {
        assert_eq!(parse_chat_row_show(&Raw::Null, PHONE_CHAT_ROW_SHOW), PHONE_CHAT_ROW_SHOW);
        let saved = object(vec![("branch", Raw::Bool(true)), ("diff", Raw::Str("yes".into())), ("extra", Raw::Bool(true))]);
        assert_eq!(parse_chat_row_show(&saved, DESKTOP_CHAT_ROW_SHOW), ChatRowShow { branch: true, ..DESKTOP_CHAT_ROW_SHOW });
        let off = object(vec![("computer", Raw::Bool(false)), ("lastActivity", Raw::Bool(true))]);
        let parsed = parse_chat_row_show(&off, DESKTOP_CHAT_ROW_SHOW);
        assert!(!parsed.get(ChatRowField::Computer));
        assert!(parsed.get(ChatRowField::LastActivity));
    }

    #[test]
    fn the_defaults_and_the_menu_order() {
        assert_eq!(
            CHAT_ROW_FIELDS.map(|(field, _)| field.id()),
            ["computer", "pullRequests", "linearIssue", "branch", "diff", "lastActivity"]
        );
        assert_eq!([PHONE_CHAT_ROW_SHOW.branch, DESKTOP_CHAT_ROW_SHOW.branch], [true, false]);
        assert!(CHAT_ROW_FIELDS.iter().all(|(field, _)| DESKTOP_CHAT_ROW_SHOW.get(*field)
            == matches!(field, ChatRowField::Computer | ChatRowField::PullRequests | ChatRowField::LinearIssue)));
    }

    #[test]
    fn last_activity_reads_short() {
        let now = 10.0 * 7.0 * 24.0 * 3_600_000.0;
        assert_eq!(activity_ago(now - 30_000.0, now), "now");
        assert_eq!(activity_ago(now - 5.0 * 60_000.0, now), "5m");
        assert_eq!(activity_ago(now - 3.0 * 3_600_000.0, now), "3h");
        assert_eq!(activity_ago(now - 2.0 * 24.0 * 3_600_000.0, now), "2d");
        assert_eq!(activity_ago(now - 15.0 * 24.0 * 3_600_000.0, now), "2w");
        assert_eq!(activity_ago(now + 5000.0, now), "now");
        assert_eq!(activity_ago(now - 60_000.0, now), "1m");
        assert_eq!(activity_ago(now - 7.0 * 24.0 * 3_600_000.0, now), "1w");
    }
}
