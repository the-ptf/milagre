//! The Chats home is the one internal Git repository each computer keeps so Chats without a Project have a
//! Worktree to run in (`packages/shared/src/chats-home.mjs`). It is a Project like any other to the daemon, so
//! screens tell it apart by `kind`, never by its path.

use crate::data::ProjectKind;

/// Whether a Project of this `kind` string is the Chats home: only `"chats"` is.
pub fn is_chats_home_project(kind: Option<&str>) -> bool {
    kind == Some("chats")
}

/// [`is_chats_home_project`] for the domain type.
pub fn is_chats_home(kind: ProjectKind) -> bool {
    kind == ProjectKind::ChatsHome
}

/// The sidebar and picker group for these Chats. Not a path, so it can't collide with a Project's folder.
pub const CHATS_GROUP_KEY: &str = "milagre-chats";

pub const NO_PROJECT_LABEL: &str = "No Project";
pub const CHATS_GROUP_LABEL: &str = "Chats";
pub const ALL_CHATS_LABEL: &str = "All Chats";
pub const CHATS_ACCOUNT_LABEL: &str = "Chats without a Project";
/// Under the Chats home's name in Project Accounts, where a Project says "Project".
pub const CHATS_ACCOUNT_DETAIL: &str = "Every quick Chat on this computer";

// A new Chat without a Project, on desktop and phone: its heading, the tray above the composer and the empty composer.
pub const JUST_CHAT_HEADING: &str = "Just chat";
pub const CHATS_TRAY_LABEL: &str = "Yapping around";
pub const CHATS_PLACEHOLDER: &str = "Ask anything";
/// What No Project gives a Chat, under its name in the pickers.
pub const NO_PROJECT_FOLDER: &str = "Its own empty folder";
/// The phone's line under "Just chat on <Computer>", which goes back to the Projects:
/// "No Project · its own empty folder".
pub const NO_PROJECT_LINE: &str = "No Project · its own empty folder";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_project_of_kind_chats_is_the_chats_home() {
        assert!(is_chats_home_project(Some("chats")));
        assert!(!is_chats_home_project(None));
        assert!(!is_chats_home_project(Some("other")));
        assert!(!is_chats_home_project(Some("Chats")));
        assert!(is_chats_home(ProjectKind::ChatsHome));
        assert!(!is_chats_home(ProjectKind::Project));
    }

    #[test]
    fn the_group_key_can_never_be_a_path_and_the_labels_are_the_ones_the_screens_show() {
        assert_eq!(CHATS_GROUP_KEY, "milagre-chats");
        assert!(!CHATS_GROUP_KEY.contains('/'));
        assert_eq!(
            [NO_PROJECT_LABEL, CHATS_GROUP_LABEL, ALL_CHATS_LABEL, CHATS_ACCOUNT_LABEL, CHATS_ACCOUNT_DETAIL],
            ["No Project", "Chats", "All Chats", "Chats without a Project", "Every quick Chat on this computer"]
        );
    }

    #[test]
    fn a_new_chat_without_a_project_says_the_same_on_desktop_and_phone() {
        assert_eq!(
            [JUST_CHAT_HEADING, CHATS_TRAY_LABEL, CHATS_PLACEHOLDER, NO_PROJECT_FOLDER, NO_PROJECT_LINE],
            ["Just chat", "Yapping around", "Ask anything", "Its own empty folder", "No Project · its own empty folder"]
        );
        // The line is built from the other two, as the TypeScript template does.
        assert_eq!(NO_PROJECT_LINE, format!("{NO_PROJECT_LABEL} · {}", NO_PROJECT_FOLDER.to_lowercase()));
    }
}
